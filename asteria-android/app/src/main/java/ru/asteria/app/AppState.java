package ru.asteria.app;

/**
 * Небольшое общее состояние процесса — заменяет собой Firebase-токен как
 * способ решить, нужно ли показывать системное уведомление о новом
 * сообщении.
 *
 * activeConversationId обновляется из веб-страницы через мост
 * WebAppInterface.setActiveConversation() (см. reportActiveChatToNative() в
 * public/app.js) — там же, где раньше был AsteriaNotify.show().
 * AsteriaPushService читает оба поля перед показом уведомления и пропускает
 * его, если пользователь прямо сейчас смотрит именно на этот чат — то же
 * самое условие isViewingThisChat, что и в браузерной версии.
 */
final class AppState {
    private AppState() { }

    // "" (не null) — ни один чат сейчас не открыт.
    static volatile String activeConversationId = "";
    // true между onResume() и onPause() у MainActivity. Важно проверять
    // вместе с activeConversationId: если приложение свернули, пока был
    // открыт чат X, activeConversationId так и останется равен X, пока
    // пользователь не откроет другой чат — без проверки foreground сервис
    // решил бы, что пользователь до сих пор смотрит на X, и молча
    // проглотил бы уведомление о новом сообщении в этом чате.
    static volatile boolean foreground = false;

    static boolean isViewingConversation(String conversationId) {
        if (conversationId == null || !foreground) return false;
        return conversationId.equals(activeConversationId);
    }
}
