import { flashChatManager } from './flashChatManager';
import { flashChatService } from './flashChatService';

export async function initFlashChat() {
    await flashChatManager.init();
    await flashChatService.startAll();
}
