export const OfflineMessageType = {
  GetStatus: 'GET_STATUS',
  PrepareResources: 'PREPARE_RESOURCES',
  GetCandidateState: 'GET_CANDIDATE_STATE',
  Status: 'STATUS',
  CandidateState: 'CANDIDATE_STATE',
  PrepareUpdate: 'PREPARE_UPDATE',
  AbortUpdate: 'ABORT_UPDATE',
  ActivateUpdate: 'ACTIVATE_UPDATE',
  GetUpdateStatus: 'GET_UPDATE_STATUS',
  UpdatePrepared: 'UPDATE_PREPARED',
  UpdateAborted: 'UPDATE_ABORTED',
  UpdateActivating: 'UPDATE_ACTIVATING',
  UpdateStatus: 'UPDATE_STATUS',
  PrepareClientUpdate: 'PREPARE_CLIENT_UPDATE',
  AbortClientUpdate: 'ABORT_CLIENT_UPDATE',
  ClientUpdateReady: 'CLIENT_UPDATE_READY',
  ClientUpdateAborted: 'CLIENT_UPDATE_ABORTED',
} as const

export type OfflineMessageType =
  (typeof OfflineMessageType)[keyof typeof OfflineMessageType]

export const OfflinePreparation = {
  Ready: 'ready',
  Incomplete: 'incomplete',
  Error: 'error',
} as const

export type OfflinePreparation =
  (typeof OfflinePreparation)[keyof typeof OfflinePreparation]

export const OfflinePhase = {
  Idle: 'idle',
  Unknown: 'unknown',
  Preparing: 'preparing',
  Prepared: 'prepared',
  Activating: 'activating',
  Aborted: 'aborted',
} as const

export type OfflinePhase = (typeof OfflinePhase)[keyof typeof OfflinePhase]

export const offlineProtocol = 'einvoice-offline' as const

// La versión 2 confirma la actualización solo después de guardar su
// autorización. Un cliente antiguo no puede participar de forma segura en ese
// cambio.
export const offlineProtocolVersion = 2 as const

export interface OfflineIdentity {
  readonly appReleaseId: string
  readonly modelPackageId: string
}

export interface OfflineEnvelope {
  protocol: typeof offlineProtocol
  version: typeof offlineProtocolVersion
  requestId: string
}

type ResourceRequest = OfflineEnvelope &
  (
    | {
        type: typeof OfflineMessageType.GetStatus
        expected: OfflineIdentity
      }
    | {
        type: typeof OfflineMessageType.PrepareResources
        expected: OfflineIdentity
      }
  )

export interface UpdateRequest extends OfflineEnvelope {
  type:
    | typeof OfflineMessageType.PrepareUpdate
    | typeof OfflineMessageType.AbortUpdate
    | typeof OfflineMessageType.ActivateUpdate
    | typeof OfflineMessageType.GetUpdateStatus
  expected: OfflineIdentity
  attemptId: string
}

export interface CandidateStateRequest extends OfflineEnvelope {
  type: typeof OfflineMessageType.GetCandidateState
  expected: OfflineIdentity
}

export type CandidatePhase =
  | typeof OfflinePhase.Idle
  | typeof OfflinePhase.Unknown
  | typeof OfflinePhase.Preparing
  | typeof OfflinePhase.Prepared
  | typeof OfflinePhase.Activating

export interface CandidateState extends OfflineEnvelope {
  type: typeof OfflineMessageType.CandidateState
  identity: OfflineIdentity
  phase: CandidatePhase
  attemptId?: string
}

export type OfflineRequest =
  ResourceRequest | UpdateRequest | CandidateStateRequest

export interface OfflineStatus extends OfflineEnvelope {
  type: typeof OfflineMessageType.Status
  identity: OfflineIdentity
  matchesExpected: boolean
  preparation:
    | typeof OfflinePreparation.Ready
    | typeof OfflinePreparation.Incomplete
    | typeof OfflinePreparation.Error
  uiComplete: boolean
  classifierComplete: boolean
  error?: string
}

export type UpdatePhase =
  | typeof OfflinePhase.Unknown
  | typeof OfflinePhase.Preparing
  | typeof OfflinePhase.Prepared
  | typeof OfflinePhase.Activating
  | typeof OfflinePhase.Aborted

export interface UpdateResponse extends OfflineEnvelope {
  type:
    | typeof OfflineMessageType.UpdatePrepared
    | typeof OfflineMessageType.UpdateAborted
    | typeof OfflineMessageType.UpdateActivating
    | typeof OfflineMessageType.UpdateStatus
  identity: OfflineIdentity
  attemptId: string
  accepted: boolean
  phase: UpdatePhase
  clientIds: string[]
  error?: string
}

export interface ClientUpdateRequest extends OfflineEnvelope {
  type:
    | typeof OfflineMessageType.PrepareClientUpdate
    | typeof OfflineMessageType.AbortClientUpdate
  attemptId: string
  candidate: OfflineIdentity
  initiatorClientId: string
}

export interface ClientUpdateResponse extends OfflineEnvelope {
  type:
    | typeof OfflineMessageType.ClientUpdateReady
    | typeof OfflineMessageType.ClientUpdateAborted
  attemptId: string
  candidate: OfflineIdentity
  accepted: boolean
  reason?: string
}

export type OfflineResponse = OfflineStatus | UpdateResponse | CandidateState

export function isOfflineIdentity(value: unknown): value is OfflineIdentity {
  if (!value || typeof value !== 'object') {
    return false
  }

  const identity = value as Record<string, unknown>

  return (
    typeof identity.appReleaseId === 'string' &&
    identity.appReleaseId.length > 0 &&
    typeof identity.modelPackageId === 'string' &&
    identity.modelPackageId.length > 0
  )
}

export function sameOfflineIdentity(
  left: OfflineIdentity,
  right: OfflineIdentity,
): boolean {
  return (
    left.appReleaseId === right.appReleaseId &&
    left.modelPackageId === right.modelPackageId
  )
}

export function isOfflineEnvelope(value: unknown): value is OfflineEnvelope {
  if (!value || typeof value !== 'object') {
    return false
  }

  const envelope = value as Record<string, unknown>

  return (
    envelope.protocol === offlineProtocol &&
    envelope.version === offlineProtocolVersion &&
    typeof envelope.requestId === 'string' &&
    envelope.requestId.length > 0 &&
    envelope.requestId.length <= 200
  )
}

export function isOfflineRequest(value: unknown): value is OfflineRequest {
  if (!isOfflineEnvelope(value)) {
    return false
  }

  const request = value as unknown as Record<string, unknown>

  if (!isOfflineIdentity(request.expected)) {
    return false
  }

  if (
    request.type === OfflineMessageType.GetStatus ||
    request.type === OfflineMessageType.PrepareResources ||
    request.type === OfflineMessageType.GetCandidateState
  ) {
    return true
  }

  const requestType = String(request.type)

  return (
    [
      OfflineMessageType.PrepareUpdate,
      OfflineMessageType.AbortUpdate,
      OfflineMessageType.ActivateUpdate,
      OfflineMessageType.GetUpdateStatus,
    ].some((type) => type === requestType) &&
    typeof request.attemptId === 'string' &&
    request.attemptId.length > 0 &&
    request.attemptId.length <= 200
  )
}
