import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

type ConditionalArgs<
    TEvents extends Record<TEvent, unknown>,
    TEvent extends keyof TEvents
> = TEvents[TEvent] extends undefined ? [eventName: TEvent] : [eventName: TEvent, payload: TEvents[TEvent]];

type AnyData = { [key: string]: unknown };
type EventName<TEvents extends Record<string, unknown>> = keyof TEvents;

type TinyEmitterOptions = {
    name: string;
    /** Indicates this is private, part of a class instance, used internally by that class to emit externally */
    isPrivate?: boolean;
    /** Enable or disable logging for this emitter */
    loggingEnabled?: boolean;
};

export class TinyEmitter<TEvents extends Partial<AnyData> = AnyData> {
    private name: string;
    private loggingEnabled: boolean;
    private isPrivate: boolean;
    private readonly eventBus: EventEmitter;

    // star listeners: called on every emitted event
    private starListeners = new Map<
        string,
        <TEventName extends EventName<TEvents>>(eventName: TEventName, payload?: TEvents[TEventName]) => void
    >();

    constructor({ name, isPrivate = false, loggingEnabled = true }: TinyEmitterOptions) {
        this.eventBus = new EventEmitter();
        this.name = name;
        this.isPrivate = isPrivate;
        this.loggingEnabled = loggingEnabled;
    }

    on<TEvent extends keyof TEvents>(eventName: TEvent, handlerFn: (payload: TEvents[TEvent]) => unknown) {
        const nativeEventHandler = (payload: TEvents[TEvent]) => {
            handlerFn(payload);
        };

        this.eventBus.on(String(eventName), nativeEventHandler);
        return () => {
            this.eventBus.off(String(eventName), nativeEventHandler);
        };
    }

    onAll(
        handlerFn: <TEventName extends EventName<TEvents>>(
            eventName: TEventName,
            payload?: TEvents[TEventName]
        ) => unknown
    ) {
        const listenerId = randomUUID();
        this.starListeners.set(listenerId, handlerFn);

        return () => {
            this.starListeners.delete(listenerId);
        };
    }

    once<TEvent extends keyof TEvents>(
        eventName: TEvent,
        handlerFn: (payload: TEvents[TEvent]) => unknown,
        filter?: (payload: TEvents[TEvent]) => boolean
    ) {
        const wrapped = (payload: TEvents[TEvent]) => {
            if (filter && !filter(payload)) return;
            handlerFn(payload);
            this.eventBus.off(String(eventName), wrapped);
        };

        this.eventBus.on(String(eventName), wrapped);
        return () => this.eventBus.off(String(eventName), wrapped);
    }

    emit<TEvent extends keyof TEvents>(...args: ConditionalArgs<TEvents, TEvent>) {
        const [eventName, payload] = args;

        if (this.loggingEnabled) {
            if (this.isPrivate) {
                console.log(`%c ${this.name}: ${String(eventName)}`, 'color: #3a86ca', clearLargeProperties(payload));
            } else {
                console.log(
                    `%c == Emitting Event == "${String(eventName)}"`,
                    'color: #3a86ca',
                    clearLargeProperties(payload)
                );
            }
        }

        this.eventBus.emit(String(eventName), payload as TEvents[TEvent]);

        // notify * listeners
        this.starListeners.forEach((listener) => {
            // Types are preserved for callers via generics; at runtime this is fine
            (listener as any)(eventName, payload);
        });
    }

    async wait<TEvent extends keyof TEvents>(eventName: TEvent, filter?: (payload: TEvents[TEvent]) => boolean) {
        console.log(`Waiting for event: ${String(eventName)}`);
        return new Promise<TEvents[TEvent]>((resolve) => {
            this.once(
                eventName,
                (payload) => {
                    console.log(`Event received: ${String(eventName)}`);
                    resolve(payload);
                },
                filter
            );
        });
    }

    dispose() {
        this.eventBus.removeAllListeners();
        this.starListeners.clear();
    }
}

// unchanged except: make Blob check safe in Node
function clearLargeProperties(payload: unknown): unknown {
    const MAX_STRING_LENGTH = 1000;
    const visited = new WeakMap<object, unknown>();

    const isPlainObject = (obj: unknown): obj is Record<string, unknown> => {
        if (typeof obj !== 'object' || obj === null) return false;
        const proto = Object.getPrototypeOf(obj) as unknown;
        return proto === Object.prototype || proto === null;
    };

    const hasBlob = typeof Blob !== 'undefined';

    const cloneAndClean = (value: unknown): unknown => {
        if (typeof value === 'string') {
            return value.length > MAX_STRING_LENGTH ? `[String of length ${value.length}]` : value;
        }

        if (hasBlob && value instanceof Blob) {
            return `[Blob of size ${(value as Blob).size}]`;
        }

        if (Array.isArray(value)) {
            return value.map(cloneAndClean);
        }

        if (value && typeof value === 'object') {
            if (!isPlainObject(value)) {
                return value;
            }

            if (visited.has(value as object)) {
                return visited.get(value as object);
            }

            const result: Record<string, unknown> = {};
            visited.set(value as object, result);

            for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
                try {
                    result[key] = cloneAndClean(val);
                } catch {
                    result[key] = val;
                }
            }

            return result;
        }

        return value;
    };

    return cloneAndClean(payload);
}
