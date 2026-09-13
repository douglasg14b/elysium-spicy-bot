import { interactionsRegistry } from '../../features-system/commands';
import { handleWarnClearCommand, warnClearCommand } from './commands/warnClearCommand';
import { handleWarnCommand, warnCommand } from './commands/warnCommand';
import { handleWarningsCommand, warningsCommand } from './commands/warningsCommand';
import { handleWarningsConfigCommand, warningsConfigCommand } from './commands/warningsConfigCommand';
import { WarnModalComponent } from './components/warnModal';
import { WarningsConfigModalComponent } from './components/warningsConfigModal';

let warningsInitialized = false;

export function initWarnings(): void {
    if (warningsInitialized) {
        return;
    }

    warningsInitialized = true;

    const warnModal = WarnModalComponent();
    const warningsConfigModal = WarningsConfigModalComponent();

    interactionsRegistry.register(warnCommand, handleWarnCommand);
    interactionsRegistry.register(warningsCommand, handleWarningsCommand);
    interactionsRegistry.register(warnClearCommand, handleWarnClearCommand);
    interactionsRegistry.register(warningsConfigCommand, handleWarningsConfigCommand);
    interactionsRegistry.register(warnModal.component, warnModal.handler);
    interactionsRegistry.register(warningsConfigModal.component, warningsConfigModal.handler);
}

export function resetWarningsInitializationForTests(): void {
    warningsInitialized = false;
}
