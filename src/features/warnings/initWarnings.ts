import { interactionsRegistry } from '../../features-system/commands';
import { handleWarnClearCommand, warnClearCommand } from './commands/warnClearCommand';
import { handleWarnCommand, warnCommand } from './commands/warnCommand';
import { handleWarningsCommand, warningsCommand } from './commands/warningsCommand';
import { WarnModalComponent } from './components/warnModal';

let warningsInitialized = false;

export function initWarnings(): void {
    if (warningsInitialized) {
        return;
    }

    warningsInitialized = true;

    const warnModal = WarnModalComponent();

    interactionsRegistry.register(warnCommand, handleWarnCommand);
    interactionsRegistry.register(warningsCommand, handleWarningsCommand);
    interactionsRegistry.register(warnClearCommand, handleWarnClearCommand);
    interactionsRegistry.register(warnModal.component, warnModal.handler);
}

export function resetWarningsInitializationForTests(): void {
    warningsInitialized = false;
}
