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
