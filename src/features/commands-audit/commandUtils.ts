import { AdditionalData } from '../../shared';
import { CommandHandlerResult } from '../commands/commandRegistry';

export function commandSuccess(message?: string, additionalData?: AdditionalData): CommandHandlerResult {
    return {
        status: 'success',
        message,
        additionalData,
    };
}

export function commandError(message?: string, additionalData?: AdditionalData): CommandHandlerResult {
    return {
        status: 'error',
        message,
        additionalData,
    };
}

export function commandSkipped(message?: string, additionalData?: AdditionalData): CommandHandlerResult {
    return {
        status: 'skipped',
        message,
        additionalData,
    };
}
