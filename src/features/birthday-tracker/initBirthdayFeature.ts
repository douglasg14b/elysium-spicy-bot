import { interactionsRegistry } from '../../features-system/commands';
import { birthdayCommand, handleBirthdayCommand } from './commands/birthdayCommand';
import { birthdayConfigCommand, handleBirthdayConfigCommand } from './commands/birthdayConfigCommand';
import { birthdayModal, handleBirthdayModal } from './birthdayModalHandler';
import {
    birthdayUpdateButton,
    handleBirthdayUpdateButton,
    birthdayDeleteButton,
    handleBirthdayDeleteButton,
} from './birthdayActionSelectHandler';

/**
 * Initializes the birthday tracker feature handlers
 */
export function initBirthdayFeature(): void {
    // Register birthday command
    interactionsRegistry.register(birthdayCommand, handleBirthdayCommand);
    interactionsRegistry.register(birthdayConfigCommand, handleBirthdayConfigCommand);

    // Register birthday modal
    interactionsRegistry.register(birthdayModal, handleBirthdayModal);

    // Register birthday action buttons
    interactionsRegistry.register(birthdayUpdateButton, handleBirthdayUpdateButton);
    interactionsRegistry.register(birthdayDeleteButton, handleBirthdayDeleteButton);
}
