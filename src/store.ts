import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { stowageApi, type Cargo } from './api';

export type StowageComment = {
  id: string;
  cargoId: string;
  author: string;
  role: '船长' | '码头' | '货主';
  content: string;
  status: '待确认' | '已接受' | '已退回';
};

export type WeighRecord = {
  cargoId: string;
  batchNo: string;
  stationId: string;
  declaredWeight: number;
  verifiedWeight: number;
  deviationPct: number;
  withinTolerance: boolean;
  weighedAt: string;
};

export type WeighBatch = {
  batchNo: string;
  terminal: string;
  cargoIds: string[];
  stationId: string | null;
  status: '排队中' | '称重中' | '已完成' | '保存失败';
  completedCargoIds: string[];
  submittedAt: string;
};

export type WeighStation = {
  id: string;
  name: string;
  capacity: number;
  occupiedBy: string[];
};

export type TerminalConflict = {
  id: string;
  batchNo: string;
  terminal: string;
  cargoIds: string[];
  submittedAt: string;
  note: string;
};

type State = {
  cargo: Cargo[];
  activeCargoId: string;
  planRevision: number;
  comments: StowageComment[];
  acceptedLimits: string[];
  locked: boolean;
  viewMode: '3d' | 'section';
  draftSavedAt: string;
  stations: WeighStation[];
  weighBatches: WeighBatch[];
  weighRecords: WeighRecord[];
  terminalConflicts: TerminalConflict[];
  draftReview: '已复核' | '待补';
  upgradeNotice: string | null;
};

export const WEIGH_TOLERANCE_PCT = 5;

const initialCargo: Cargo[] = [
  { id: 'BL-88214', bill: 'SEA-88214', type: '集装箱', bay: 12, row: 4, tier: 2, deck: '主甲板', weight: 24.6, declaredWeight: 24.6, weighStatus: '未复磅', dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '已绑扎', color: '#2b7c75' },
  { id: 'BL-88219', bill: 'SEA-88219', type: '集装箱', bay: 13, row: 4, tier: 2, deck: '主甲板', weight: 28.1, declaredWeight: 28.1, weighStatus: '未复磅', dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: 'UN 1263', lashing: '需复核', color: '#c77835' },
  { id: 'BL-88231', bill: 'SEA-88231', type: '集装箱', bay: 10, row: 6, tier: 1, deck: '主甲板', weight: 18.2, declaredWeight: 18.2, weighStatus: '未复磅', dimension: '20 × 8 × 8.6 ft', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#366d94' },
  { id: 'BL-88240', bill: 'SEA-88240', type: '集装箱', bay: 8, row: 2, tier: 2, deck: '货舱', weight: 31.4, declaredWeight: 31.4, weighStatus: '未复磅', dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '待绑扎', color: '#6d528d' },
  { id: 'BL-88247', bill: 'SEA-88247', type: '重大件', bay: 15, row: 0, tier: 1, deck: '主甲板', weight: 112.5, declaredWeight: 112.5, weighStatus: '未复磅', dimension: '18.4 × 4.2 × 4.8 m', port: '温哥华', hazmat: '无', lashing: '需复核', color: '#b64f49' },
  { id: 'BL-88254', bill: 'SEA-88254', type: '散货', bay: 5, row: 0, tier: 0, deck: '货舱', weight: 286.0, declaredWeight: 286.0, weighStatus: '未复磅', dimension: '散装 / 420 m³', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#9a7836' }
];

const defaultStations: WeighStation[] = [
  { id: 'WS-1', name: '1 号称重台 · 80t 地磅', capacity: 1, occupiedBy: [] },
  { id: 'WS-2', name: '2 号称重台 · 120t 地磅', capacity: 1, occupiedBy: [] }
];

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

// 模拟码头复磅结果：围绕申报值 ±12% 波动，按箱号确定，重试时结果一致
function verifiedWeightFor(cargo: Cargo) {
  let hash = 0;
  for (const char of cargo.id) hash = (hash * 31 + char.charCodeAt(0)) % 9973;
  const offset = (hash % 25) - 12;
  return Math.round(cargo.declaredWeight * (1 + offset / 100) * 10) / 10;
}

// 称重台容量不足就排队；台位空出时按提交顺序补位
function promoteQueue(state: State) {
  state.weighBatches.filter((item) => item.status === '排队中').forEach((batch) => {
    const station = state.stations.find((item) => item.occupiedBy.length < item.capacity);
    if (!station) return;
    station.occupiedBy.push(batch.batchNo);
    batch.stationId = station.id;
    batch.status = '称重中';
  });
}

function releaseStation(state: State, batch: WeighBatch) {
  const station = state.stations.find((item) => item.id === batch.stationId);
  if (station) station.occupiedBy = station.occupiedBy.filter((no) => no !== batch.batchNo);
  promoteQueue(state);
}

function baseState(): State {
  return {
    cargo: initialCargo,
    activeCargoId: 'BL-88247',
    planRevision: 5,
    comments: [
      { id: 'CM-21', cargoId: 'BL-88219', author: '港方配载', role: '码头', content: '危险品箱与船员生活区保持隔离，请在最终图中标注危险品隔离线。', status: '待确认' },
      { id: 'CM-22', cargoId: 'BL-88247', author: '周船长', role: '船长', content: '重大件横向支撑需增加两组绑扎点，检查甲板局部强度。', status: '待确认' },
      { id: 'CM-23', cargoId: 'BL-88254', author: '货主代表', role: '货主', content: '釜山港卸货前不得覆盖散货舱口，已接受当前安排。', status: '已接受' }
    ],
    acceptedLimits: [],
    locked: false,
    viewMode: '3d',
    draftSavedAt: '09:52',
    stations: defaultStations,
    weighBatches: [],
    weighRecords: [],
    terminalConflicts: [],
    draftReview: '待补',
    upgradeNotice: null
  };
}

function loadInitialState(): State {
  const base = baseState();
  if (typeof localStorage === 'undefined') return base;
  const raw = localStorage.getItem('yy62-stowage-plan');
  if (!raw) return base;
  try {
    const saved = JSON.parse(raw) as Partial<State>;
    const merged: State = {
      ...base,
      ...saved,
      stations: saved.stations ?? base.stations,
      weighBatches: saved.weighBatches ?? [],
      weighRecords: saved.weighRecords ?? [],
      terminalConflicts: saved.terminalConflicts ?? []
    };
    // 旧稿缺复核记录时升级并标待补
    if (!saved.weighRecords || saved.draftReview === undefined) {
      merged.cargo = merged.cargo.map((item) => ({ ...item, declaredWeight: item.declaredWeight ?? item.weight, weighStatus: item.weighStatus ?? '未复磅' }));
      merged.draftReview = '待补';
      merged.upgradeNotice = '检测到旧版草稿缺少复磅复核记录，已自动升级数据结构并标记“待补”：完成复磅后请补录复核。';
    }
    return merged;
  } catch {
    return base;
  }
}

const slice = createSlice({
  name: 'stowage',
  initialState: loadInitialState(),
  reducers: {
    selectCargo(state, action: PayloadAction<string>) { state.activeCargoId = action.payload; },
    moveCargo(state, action: PayloadAction<{ id: string; bay: number; row: number; tier: number }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (cargo) Object.assign(cargo, action.payload);
      state.planRevision += 1;
      state.draftSavedAt = now();
    },
    updateLashing(state, action: PayloadAction<{ id: string; lashing: Cargo['lashing'] }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (cargo) cargo.lashing = action.payload.lashing;
    },
    addComment(state, action: PayloadAction<{ cargoId: string; author: string; role: StowageComment['role']; content: string }>) {
      state.comments.unshift({ ...action.payload, id: `CM-${Date.now()}`, status: '待确认' });
    },
    acceptComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (comment) comment.status = '已接受';
    },
    rejectComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (comment) comment.status = '已退回';
    },
    acceptLimit(state, action: PayloadAction<string>) {
      if (!state.acceptedLimits.includes(action.payload)) state.acceptedLimits.push(action.payload);
    },
    setViewMode(state, action: PayloadAction<'3d' | 'section'>) { state.viewMode = action.payload; },
    submitWeighBatch(state, action: PayloadAction<{ batchNo: string; terminal: string; cargoIds: string[] }>) {
      const { batchNo, terminal, cargoIds } = action.payload;
      if (!batchNo.trim() || !cargoIds.length) return;
      const existing = state.weighBatches.find((item) => item.batchNo === batchNo.trim());
      if (existing) {
        // 两个终端同时提交同一批次：先到者占用，后到内容留作冲突
        state.terminalConflicts.unshift({ id: `TC-${Date.now()}`, batchNo: batchNo.trim(), terminal, cargoIds, submittedAt: now(), note: `批次 ${batchNo.trim()} 已由${existing.terminal}提交（${existing.status}），本次提交内容保留为冲突，未重复占台。` });
        return;
      }
      state.weighBatches.push({ batchNo: batchNo.trim(), terminal, cargoIds, stationId: null, status: '排队中', completedCargoIds: [], submittedAt: now() });
      promoteQueue(state);
    },
    weighNextContainer(state, action: PayloadAction<string>) {
      const batch = state.weighBatches.find((item) => item.batchNo === action.payload);
      if (!batch || batch.status !== '称重中') return;
      const cargoId = batch.cargoIds.find((id) => !batch.completedCargoIds.includes(id));
      if (!cargoId) return;
      const cargo = state.cargo.find((item) => item.id === cargoId);
      if (!cargo) return;
      const verifiedWeight = verifiedWeightFor(cargo);
      const deviationPct = Math.round(((verifiedWeight - cargo.declaredWeight) / cargo.declaredWeight) * 1000) / 10;
      const withinTolerance = Math.abs(deviationPct) <= WEIGH_TOLERANCE_PCT;
      batch.completedCargoIds.push(cargoId);
      state.weighRecords = state.weighRecords.filter((item) => item.cargoId !== cargoId);
      state.weighRecords.unshift({ cargoId, batchNo: batch.batchNo, stationId: batch.stationId ?? '', declaredWeight: cargo.declaredWeight, verifiedWeight, deviationPct, withinTolerance, weighedAt: now() });
      cargo.weighStatus = '已复磅';
      if (!withinTolerance) {
        // 超出容差以复磅值为准；重量改动后立即重算稳性与绑扎
        cargo.weight = verifiedWeight;
        if (cargo.lashing === '已绑扎') cargo.lashing = '需复核';
      }
      state.planRevision += 1;
      state.draftSavedAt = now();
      if (batch.completedCargoIds.length === batch.cargoIds.length) {
        batch.status = '已完成';
        releaseStation(state, batch);
      }
    },
    failBatchSave(state, action: PayloadAction<string>) {
      const batch = state.weighBatches.find((item) => item.batchNo === action.payload);
      if (batch && batch.status === '称重中') batch.status = '保存失败';
    },
    retryBatchSave(state, action: PayloadAction<string>) {
      const batch = state.weighBatches.find((item) => item.batchNo === action.payload);
      if (!batch || batch.status !== '保存失败') return;
      // 保存失败后从最后完成箱恢复；按批次号重试不重复占台
      const station = state.stations.find((item) => item.id === batch.stationId);
      if (station && station.occupiedBy.includes(batch.batchNo)) {
        batch.status = '称重中';
      } else {
        batch.stationId = null;
        batch.status = '排队中';
        promoteQueue(state);
      }
    },
    completeReview(state) {
      if (state.cargo.every((item) => item.weighStatus === '已复磅')) {
        state.draftReview = '已复核';
        state.upgradeNotice = null;
      }
    },
    lockPlan(state) {
      // 没复磅的不能锁定
      if (state.cargo.some((item) => item.weighStatus !== '已复磅')) return;
      state.locked = true;
      state.planRevision += 1;
    }
  }
});

export const { selectCargo, moveCargo, updateLashing, addComment, acceptComment, rejectComment, acceptLimit, setViewMode, submitWeighBatch, weighNextContainer, failBatchSave, retryBatchSave, completeReview, lockPlan } = slice.actions;

export const store = configureStore({
  reducer: { stowage: slice.reducer, [stowageApi.reducerPath]: stowageApi.reducer },
  middleware: (getDefault) => getDefault().concat(stowageApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy62-stowage-plan', JSON.stringify(store.getState().stowage));
});

export type RootState = ReturnType<typeof store.getState>;

// 重叠时后到批次的等待位置（排队序号，从 1 开始）
export function queuePosition(state: State, batchNo: string) {
  const queued = state.weighBatches.filter((item) => item.status === '排队中');
  const index = queued.findIndex((item) => item.batchNo === batchNo);
  return index === -1 ? null : index + 1;
}

export function unweighedCargo(state: State) {
  return state.cargo.filter((item) => item.weighStatus !== '已复磅');
}

export function calculateStability(cargo: Cargo[]) {
  const total = cargo.reduce((sum, item) => sum + item.weight, 0);
  const longitudinal = cargo.reduce((sum, item) => sum + item.weight * item.bay, 0) / Math.max(total, 1);
  const vertical = cargo.reduce((sum, item) => sum + item.weight * (item.tier + 1), 0) / Math.max(total, 1);
  const deckLoad = cargo.filter((item) => item.deck === '主甲板').reduce((sum, item) => sum + item.weight, 0);
  const stability = Math.max(0, 92 - Math.abs(longitudinal - 10.8) * 2.2 - Math.max(0, vertical - 1.75) * 8);
  return {
    total,
    longitudinal,
    vertical,
    deckLoad,
    stability,
    trim: (longitudinal - 10.8) < -0.4 ? '艉倾' : (longitudinal - 10.8) > 0.4 ? '艏倾' : '正平'
  };
}

export function detectConflicts(cargo: Cargo[]) {
  const issues: { id: string; cargoId: string; level: 'high' | 'medium'; title: string; detail: string }[] = [];
  const slots = new Map<string, Cargo>();
  cargo.forEach((item) => {
    const key = `${item.deck}-${item.bay}-${item.row}-${item.tier}`;
    const existing = slots.get(key);
    if (existing) issues.push({ id: `${item.id}-overlap`, cargoId: item.id, level: 'high', title: '货位重叠', detail: `${item.id} 与 ${existing.id} 占用相同二维货位。` });
    slots.set(key, item);
    if (item.hazmat !== '无' && item.deck === '主甲板' && item.row <= 1) issues.push({ id: `${item.id}-hazmat`, cargoId: item.id, level: 'high', title: '危险品隔离不足', detail: `${item.id} 与船体边界距离小于方案要求。` });
    if (item.weight > 100 && item.lashing !== '已绑扎') issues.push({ id: `${item.id}-lashing`, cargoId: item.id, level: 'medium', title: '重大件绑扎未完成', detail: `${item.id} 重量 ${item.weight}t，绑扎状态为“${item.lashing}”。` });
    if (item.type === '集装箱' && item.weight > 30 && item.tier >= 3) issues.push({ id: `${item.id}-stack`, cargoId: item.id, level: 'medium', title: '上层堆重超限', detail: `${item.id} 不应放在第 ${item.tier} 层。` });
  });
  return issues;
}
