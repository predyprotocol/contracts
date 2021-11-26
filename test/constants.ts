import { scaledBN } from './utils/helpers'

// the dispute period of price oracle
export const DISPUTE_PERIOD = 60 * 60 * 2
export const EXTENSION_PERIOD = 60 * 60 * 24 * 3

export const INITIAL_IV = scaledBN(50, 6)

export enum MarginLevel {
  Maintenance = 0,
  Initial = 1,
  Safe = 2,
}

export enum AMMConfig {
  PROTOCOL_FEE_RATIO = 1,
  IVMOVE_DECREASE_RATIO = 2,
  MIN_DELTA = 3,
  BASE_SPREAD = 4,
}

export enum OptionVaultConfig {
  MM_RATIO = 1,
  IM_RATIO = 2,
  CALL_SAFE_RATIO = 3,
  PUT_SAFE_RATIO = 4,
  SLIPPAGE_TOLERANCE = 5,
  EXTENSION_PERIOD = 6,
  MIN_SIZE = 7,
  BASE_LIQ_REWARD = 8,
}

export const LOCKUP_PERIOD = 60 * 60 * 24 * 14
