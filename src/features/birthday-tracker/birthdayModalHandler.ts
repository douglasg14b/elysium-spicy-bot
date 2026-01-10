import { ModalBuilder } from 'discord.js';
import { BirthdayModalComponent, BIRTHDAY_MODAL_ID } from './components/birthdayModal';

export const birthdayModal = new ModalBuilder().setCustomId(BIRTHDAY_MODAL_ID);

export const handleBirthdayModal = BirthdayModalComponent.handleModalSubmit;
