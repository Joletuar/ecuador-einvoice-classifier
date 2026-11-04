import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type {
  ProcessingSummary,
  XmlProgress,
} from '../services/processingService'
import type { SourceCounts } from '../../../workers/workerProtocol'

export const ActivityPhase = {
  Idle: 'idle',
  Loading: 'loading',
  Processing: 'processing',
  Finalizing: 'finalizing',
  Saving: 'saving',
  Completed: 'completed',
  Cancelled: 'cancelled',
  Failed: 'failed',
  Unavailable: 'unavailable',
} as const

export type ActivityPhase = (typeof ActivityPhase)[keyof typeof ActivityPhase]

export const ActivityOperation = {
  Selection: 'selection',
  Processing: 'processing',
} as const

export type ActivityOperation =
  (typeof ActivityOperation)[keyof typeof ActivityOperation]

export const ActivityMetric = {
  Loaded: 'loaded',
  Finished: 'finished',
} as const

export type ActivityMetric =
  (typeof ActivityMetric)[keyof typeof ActivityMetric]

export interface BatchActivity {
  operation:
    typeof ActivityOperation.Selection | typeof ActivityOperation.Processing
  phase: ActivityPhase
  metric: typeof ActivityMetric.Loaded | typeof ActivityMetric.Finished
  completed: number
  total: number
  message?: string
  tone?: typeof FeedbackTone.Warning | typeof FeedbackTone.Danger
  summary?: ProcessingSummary
  sourceName?: string
  stage?: string
  xml?: SourceCounts
  xmlProgress?: XmlProgress
}

export const activityUnits: Record<BatchActivity['metric'], string> = {
  [ActivityMetric.Loaded]: 'añadidos',
  [ActivityMetric.Finished]: 'finalizados',
}

export const activityLabels: Record<ActivityPhase, string> = {
  [ActivityPhase.Idle]: 'Prepara tus archivos',
  [ActivityPhase.Loading]: 'Añadiendo archivos',
  [ActivityPhase.Processing]: 'Procesando archivos',
  [ActivityPhase.Finalizing]: 'Confirmando resultados',
  [ActivityPhase.Saving]: 'Guardando facturas…',
  [ActivityPhase.Completed]: 'Operación terminada',
  [ActivityPhase.Cancelled]: 'Procesamiento cancelado',
  [ActivityPhase.Failed]: 'La operación necesita atención',
  [ActivityPhase.Unavailable]: 'Procesamiento no disponible',
}
