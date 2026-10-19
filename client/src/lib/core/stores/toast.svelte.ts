export type ToastMessage = {
    id: string;
    variant: "info" | "error" | "success";
    message: string;
    action?: {
        label: string;
        onClick: () => void;
    };
    durationMs?: number;
};

class ToastStore {
    toasts = $state<ToastMessage[]>([]);

    add(toast: Omit<ToastMessage, "id">): string {
        const id = crypto.randomUUID();
        const fullToast = { ...toast, id };
        this.toasts.push(fullToast);

        const durationMs = toast.durationMs ?? 6000; // default 6s
        if (durationMs > 0) {
            setTimeout(() => {
                this.remove(id);
            }, durationMs);
        }
        return id;
    }

    remove(id: string) {
        this.toasts = this.toasts.filter((t) => t.id !== id);
    }
}

export const globalToasts = new ToastStore();

/**
 * Runs an async UI action; a failure becomes an error toast (and a console line for the developer)
 * instead of an unhandled rejection that leaves the user with nothing.
 */
export async function runWithToast(
    action: () => Promise<unknown>,
    failMessage: string,
): Promise<void> {
    try {
        await action();
    } catch (e) {
        console.error(failMessage, e);
        globalToasts.add({ variant: "error", message: failMessage });
    }
}
