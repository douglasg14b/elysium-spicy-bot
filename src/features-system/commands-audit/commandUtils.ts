import { AdditionalData } from '../../shared';
import { InteractionHandlerResult } from '../commands/types';

export function commandSuccess(message?: string, additionalData?: AdditionalData): InteractionHandlerResult {
    return {
        status: 'success',
        message,
        additionalData,
    };
}

export function commandError(message?: string, additionalData?: AdditionalData): InteractionHandlerResult {
    return {
        status: 'error',
        message,
        additionalData,
    };
}

export function commandSkipped(message?: string, additionalData?: AdditionalData): InteractionHandlerResult {
    return {
        status: 'skipped',
        message,
        additionalData,
    };
}
