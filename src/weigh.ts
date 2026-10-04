import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

// 称重台：容量（单箱最大重量 t）与工位（可同时作业的批次数）
export type ScaleStatus = '空闲' | '繁忙' | '维护';
export type Scale = {
  id: string;
  name: string;
  location: string;
  capacity: number; // 单箱重量上限 t
  slots: number;    // 同时可作业批次数
  status: ScaleStatus;
};

export type BatchStatus = '排队中' | '复磅中' | '待恢复' | '待补' | '已完成';
export type WeighStatus = '待复磅' | '已复磅' | '超差' | '待补';

export type WeighRecord = {
  id: string;
  batchId: string;
  cargoId: string;
  declaredWeight: number;   // 货主申报重量
  reweighWeight: number | null; // 码头复磅重量
  deviation: number | null;    // (复磅-申报)/申报
  tolerance: number;           // 容差阈值，默认 5%
  status: WeighStatus;
  reviewed: boolean;
  reviewer: string | null;
  reviewedAt: string | null;
  completedAt: string | null;
  terminal: string | null;     // 实际提交的终端
};

export type Batch = {
  id: string;               // 批次号
  scaleId: string | null;
  status: BatchStatus;
  cargoIds: string[];
  version: number;          // 乐观锁版本号
  createdBy: string;        // 创建终端
  occupiedBy: string | null; // 先到者占用终端
  waitingPosition: number | null; // 排队位置（重叠时后到批次可见）
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastCompletedIndex: number;   // 最后完成箱在 cargoIds 中的下标，保存失败后从此恢复
  failNextSave: boolean;         // 模拟下一箱保存失败
  reviewMissing: boolean;       // 旧稿缺复核记录 → 升级标待补
  lastConflict: { terminal: string; reweighWeight: number; at: string } | null; // 后到提交留作冲突
};

type WeighState = {
  scales: Scale[];
  batches: Batch[];
  records: WeighRecord[];
  terminal: string;
  seq: number;
};

const now = () => new Date().toISOString();
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—');

const initialScales: Scale[] = [
  { id: 'S-01', name: '1 号地磅', location: '码头前沿 A 区', capacity: 40, slots: 2, status: '空闲' },
  { id: 'S-02', name: '2 号地磅', location: '码头前沿 B 区', capacity: 40, slots: 1, status: '空闲' },
  { id: 'S-03', name: '重大件地磅', location: '重件码头', capacity: 150, slots: 1, status: '空闲' },
  { id: 'S-04', name: '散货磅', location: '散货堆场', capacity: 300, slots: 1, status: '空闲' }
];

// 旧稿：早于本系统的一批复磅记录，有复磅值但缺复核记录 → 升级标待补
const legacyRecords: WeighRecord[] = [
  { id: 'PB-2609-00-BL-88214', batchId: 'PB-2609-00', cargoId: 'BL-88214', declaredWeight: 24.6, reweighWeight: 24.9, deviation: 0.0122, tolerance: 0.05, status: '已复磅', reviewed: false, reviewer: null, reviewedAt: null, completedAt: '2026-09-28T09:20:00.000Z', terminal: 'T-01' },
  { id: 'PB-2609-00-BL-88231', batchId: 'PB-2609-00', cargoId: 'BL-88231', declaredWeight: 18.2, reweighWeight: 18.0, deviation: -0.011, tolerance: 0.05, status: '已复磅', reviewed: false, reviewer: null, reviewedAt: null, completedAt: '2026-09-28T09:41:00.000Z', terminal: 'T-01' }
];

const legacyBatch: Batch = {
  id: 'PB-2609-00',
  scaleId: 'S-01',
  status: '待补',
  cargoIds: ['BL-88214', 'BL-88231'],
  version: 1,
  createdBy: 'T-01',
  occupiedBy: null,
  waitingPosition: null,
  createdAt: '2026-09-28T09:00:00.000Z',
  startedAt: '2026-09-28T09:05:00.000Z',
  finishedAt: '2026-09-28T09:41:00.000Z',
  lastCompletedIndex: 1,
  failNextSave: false,
  reviewMissing: true,
  lastConflict: null
};

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy62-weigh') : null;
const saved: Partial<WeighState> | null = raw ? JSON.parse(raw) : null;

const initialState: WeighState = saved
  ? { scales: saved.scales ?? initialScales, batches: saved.batches ?? [legacyBatch], records: saved.records ?? legacyRecords, terminal: saved.terminal ?? 'T-01', seq: saved.seq ?? 1 }
  : { scales: initialScales, batches: [legacyBatch], records: legacyRecords, terminal: 'T-01', seq: 1 };

function activeOnScale(batches: Batch[], scaleId: string) {
  return batches.filter((b) => b.scaleId === scaleId && b.status === '复磅中').length;
}

function queuedOnScale(batches: Batch[], scaleId: string) {
  return batches.filter((b) => b.scaleId === scaleId && b.status === '排队中').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function recomputeWaiting(batches: Batch[], scaleId: string) {
  queuedOnScale(batches, scaleId).forEach((b, i) => { b.waitingPosition = i + 1; });
}

function promote(state: WeighState, scaleId: string) {
  const scale = state.scales.find((s) => s.id === scaleId);
  if (!scale) return;
  if (activeOnScale(state.batches, scaleId) >= scale.slots) return;
  const next = queuedOnScale(state.batches, scaleId)[0];
  if (!next) return;
  next.status = '复磅中';
  next.startedAt = now();
  next.occupiedBy = next.createdBy; // 排队时不占台，轮到后由创建终端占用
  next.waitingPosition = null;
  recomputeWaiting(state.batches, scaleId);
}

const slice = createSlice({
  name: 'weigh',
  initialState,
  reducers: {
    setTerminal(state, action: PayloadAction<string>) {
      state.terminal = action.payload;
    },
    createBatch(state, action: PayloadAction<{ scaleId: string; items: { cargoId: string; declaredWeight: number }[] }>) {
      const scale = state.scales.find((s) => s.id === action.payload.scaleId);
      if (!scale || action.payload.items.length === 0) return;
      const id = `PB-2609-${String(state.seq).padStart(2, '0')}`;
      state.seq += 1;
      const hasSlot = activeOnScale(state.batches, scale.id) < scale.slots;
      const batch: Batch = {
        id,
        scaleId: scale.id,
        status: hasSlot ? '复磅中' : '排队中',
        cargoIds: action.payload.items.map((i) => i.cargoId),
        version: 1,
        createdBy: state.terminal,
        occupiedBy: hasSlot ? state.terminal : null,
        waitingPosition: hasSlot ? null : queuedOnScale(state.batches, scale.id).length + 1,
        createdAt: now(),
        startedAt: hasSlot ? now() : null,
        finishedAt: null,
        lastCompletedIndex: -1,
        failNextSave: false,
        reviewMissing: false,
        lastConflict: null
      };
      state.batches.push(batch);
      action.payload.items.forEach((item) => {
        state.records.push({
          id: `${id}-${item.cargoId}`,
          batchId: id,
          cargoId: item.cargoId,
          declaredWeight: item.declaredWeight,
          reweighWeight: null,
          deviation: null,
          tolerance: 0.05,
          status: '待复磅',
          reviewed: false,
          reviewer: null,
          reviewedAt: null,
          completedAt: null,
          terminal: null
        });
      });
    },
    submitRecord(state, action: PayloadAction<{ batchId: string; cargoId: string; reweighWeight: number }>) {
      const batch = state.batches.find((b) => b.id === action.payload.batchId);
      if (!batch) return;
      const record = state.records.find((r) => r.batchId === batch.id && r.cargoId === action.payload.cargoId);
      if (!record) return;
      // 乐观并发：先到者占用，后到内容留作冲突，不覆盖先到提交
      if (batch.occupiedBy && batch.occupiedBy !== state.terminal) {
        batch.lastConflict = { terminal: state.terminal, reweighWeight: action.payload.reweighWeight, at: now() };
        return;
      }
      if (!batch.occupiedBy) batch.occupiedBy = state.terminal;
      // 模拟保存失败：从最后完成箱恢复，台位不释放、不重复占台
      if (batch.failNextSave) {
        batch.failNextSave = false;
        batch.status = '待恢复';
        return;
      }
      const deviation = (action.payload.reweighWeight - record.declaredWeight) / record.declaredWeight;
      record.reweighWeight = action.payload.reweighWeight;
      record.deviation = deviation;
      record.status = Math.abs(deviation) > record.tolerance ? '超差' : '已复磅';
      record.completedAt = now();
      record.terminal = state.terminal;
      const idx = batch.cargoIds.indexOf(action.payload.cargoId);
      if (idx > batch.lastCompletedIndex) batch.lastCompletedIndex = idx;
      batch.version += 1;
      if (batch.status === '待恢复') batch.status = '复磅中';
    },
    toggleFailNextSave(state, action: PayloadAction<string>) {
      const batch = state.batches.find((b) => b.id === action.payload);
      if (batch) batch.failNextSave = !batch.failNextSave;
    },
    recoverBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((b) => b.id === action.payload);
      if (!batch || batch.status !== '待恢复') return;
      batch.status = '复磅中';
      batch.failNextSave = false;
      // 台位仍由占用终端持有，不重新排队、不重复占台；从最后完成箱的下一箱继续
    },
    reviewRecord(state, action: PayloadAction<{ batchId: string; cargoId: string; reviewer: string }>) {
      const record = state.records.find((r) => r.batchId === action.payload.batchId && r.cargoId === action.payload.cargoId);
      if (!record) return;
      record.reviewed = true;
      record.reviewer = action.payload.reviewer;
      record.reviewedAt = now();
      const batch = state.batches.find((b) => b.id === action.payload.batchId);
      const batchRecords = state.records.filter((r) => r.batchId === action.payload.batchId);
      if (batch && batch.status === '待补' && batchRecords.every((r) => r.reviewed)) {
        batch.status = '已完成';
        batch.finishedAt = now();
        batch.reviewMissing = false;
      }
    },
    finishBatch(state, action: PayloadAction<string>) {
      const batch = state.batches.find((b) => b.id === action.payload);
      if (!batch) return;
      const batchRecords = state.records.filter((r) => r.batchId === batch.id);
      if (!batchRecords.every((r) => r.status !== '待复磅')) return;
      const allReviewed = batchRecords.every((r) => r.reviewed);
      batch.reviewMissing = !allReviewed;
      batch.status = allReviewed ? '已完成' : '待补';
      batch.finishedAt = now();
      promote(state, batch.scaleId ?? '');
    }
  }
});

export const {
  setTerminal,
  createBatch,
  submitRecord,
  toggleFailNextSave,
  recoverBatch,
  reviewRecord,
  finishBatch
} = slice.actions;

export const weighReducer = slice.reducer;

// 选择器：已复磅（含超差）的箱子
export function selectReweighedIds(state: { weigh: WeighState }): Set<string> {
  return new Set(state.weigh.records.filter((r) => r.status === '已复磅' || r.status === '超差').map((r) => r.cargoId));
}

export function selectOvergaugeIds(state: { weigh: WeighState }): string[] {
  return state.weigh.records.filter((r) => r.status === '超差').map((r) => r.cargoId);
}

export { fmt };
export type { WeighState };
