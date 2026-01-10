import { ButtonBuilder, ButtonStyle, ComponentBuilder, APIButtonComponentWithCustomId } from 'discord.js';
import {
    BirthdayActionSelectComponent,
    BIRTHDAY_UPDATE_BUTTON_ID,
    BIRTHDAY_DELETE_BUTTON_ID,
} from './components/birthdayActionSelect';

export const birthdayUpdateButton = new ButtonBuilder()
    .setCustomId(BIRTHDAY_UPDATE_BUTTON_ID)
    .setStyle(ButtonStyle.Primary) as ComponentBuilder<APIButtonComponentWithCustomId>;

export const birthdayDeleteButton = new ButtonBuilder()
    .setCustomId(BIRTHDAY_DELETE_BUTTON_ID)
    .setStyle(ButtonStyle.Danger) as ComponentBuilder<APIButtonComponentWithCustomId>;

export const handleBirthdayUpdateButton = BirthdayActionSelectComponent.handleButtonInteraction;
export const handleBirthdayDeleteButton = BirthdayActionSelectComponent.handleButtonInteraction;
