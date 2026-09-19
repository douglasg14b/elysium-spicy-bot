import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getBotIdentity } from '../api/bot';
import type { BotFlavour } from '../api/types';
import { FALLBACK_BOT_NAME, brandLogoUrl } from '../brand';

/**
 * Branding for the bot account we are connected to, sourced from `GET /api/bot`.
 *
 * There is no `loading` flag and no null state by design: the fallback is the bundled
 * BrattyBot branding, so consumers always have a name and a logo to render. A cold
 * start — or a failed request — shows production branding rather than a spinner.
 */
interface BotIdentityValue {
    /** The connected bot's name, or {@link FALLBACK_BOT_NAME} before it is known. */
    name: string;
    logoUrl: string;
    flavour: BotFlavour | null;
    /** True once Discord has reported in; false means `name`/`logoUrl` are fallbacks. */
    resolved: boolean;
}

const BotIdentityContext = createContext<BotIdentityValue | undefined>(undefined);

export function BotIdentityProvider({ children }: { children: ReactNode }) {
    const [name, setName] = useState<string>(FALLBACK_BOT_NAME);
    const [flavour, setFlavour] = useState<BotFlavour | null>(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const identity = await getBotIdentity();
                if (cancelled || !identity.ready || !identity.username) return;
                setName(identity.username);
                setFlavour(identity.flavour);
                setResolved(true);
            } catch (err) {
                // Branding is not worth failing the page over — keep the fallback.
                console.error('[brand] /api/bot failed:', err);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // The served index.html carries a static title; this is the only thing that can
    // reflect which bot is actually connected, since nothing templates that HTML.
    useEffect(() => {
        document.title = `${name} — Admin`;
    }, [name]);

    const value = useMemo<BotIdentityValue>(
        () => ({ name, logoUrl: brandLogoUrl(flavour), flavour, resolved }),
        [name, flavour, resolved]
    );

    return <BotIdentityContext.Provider value={value}>{children}</BotIdentityContext.Provider>;
}

export function useBotIdentity(): BotIdentityValue {
    const ctx = useContext(BotIdentityContext);
    if (!ctx) throw new Error('useBotIdentity must be used within a BotIdentityProvider');
    return ctx;
}
