/**
 * Hold navigation away from unsaved work until the operator answers, and ask the browser
 * to warn on a reload or a closed tab.
 *
 * The router's blocker and a `beforeunload` listener, and nothing else: whether to ask is
 * `shouldConfirmLeave`'s decision, and what each answer does is the page's.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, type Blocker, type BlockerFunction } from 'react-router-dom';
import { shouldConfirmLeave } from './leaveGuard';

export interface LeaveGuard {
    /** A navigation away is being held for the operator's answer. */
    readonly prompting: boolean;
    /** Let the held navigation go. Does nothing when none is held. */
    readonly leave: () => void;
    /** Drop the held navigation and stay. Does nothing when none is held. */
    readonly stay: () => void;
}

/**
 * Guard a page against leaving while `unsaved`. Needs a data router (`RouterProvider`).
 *
 * `leave` and `stay` are safe to call after an `await`: they act on the blocker as it is
 * then, and not at all once the page has unmounted — the router drops an unmounted page's
 * blocker itself, and resolving one it has dropped would throw.
 */
export function useLeaveGuard(unsaved: boolean): LeaveGuard {
    const shouldBlock = useCallback<BlockerFunction>(
        ({ currentLocation, nextLocation }) =>
            shouldConfirmLeave({ unsaved, fromPath: currentLocation.pathname, toPath: nextLocation.pathname }),
        [unsaved]
    );
    const blocker = useBlocker(shouldBlock);

    const blockerRef = useRef(blocker);
    blockerRef.current = blocker;
    const mountedRef = useRef(false);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    /*
     * The browser's own prompt, which says nothing of ours and cannot be made to. It is
     * the autosaved draft that actually keeps the work; this only gives the operator the
     * chance to not lose the last couple of seconds of it.
     */
    useEffect(() => {
        if (!unsaved) return;
        const warn = (event: BeforeUnloadEvent): void => {
            event.preventDefault();
            // Older browsers ask only when this is set.
            event.returnValue = true;
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [unsaved]);

    /**
     * The held navigation already answered, until the router's next render replaces it.
     * Answering one twice would throw — the router refuses a second `proceed` or `reset`
     * of a blocker that has moved on — and the ref above is stale until that render.
     */
    const answeredRef = useRef<Blocker | null>(null);

    const answer = useCallback((how: 'proceed' | 'reset') => {
        const current = blockerRef.current;
        if (!mountedRef.current || current.state !== 'blocked' || answeredRef.current === current) return;
        answeredRef.current = current;
        current[how]();
    }, []);

    const leave = useCallback(() => answer('proceed'), [answer]);
    const stay = useCallback(() => answer('reset'), [answer]);

    return { prompting: blocker.state === 'blocked', leave, stay };
}
