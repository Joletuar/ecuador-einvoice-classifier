import { inject } from 'vue'
import {
  LeaveProtection,
  leaveProtectionKey,
} from '../navigation/leaveProtection'

export function useLeaveProtection(): LeaveProtection {
  const protection = inject(leaveProtectionKey)

  if (!protection) {
    throw new Error('Leave protection must be provided by the application.')
  }

  return protection
}
