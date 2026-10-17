import { browser } from "$app/environment";

declare global {
    interface Window {
        deferredPromptEvent: BeforeInstallPromptEvent | null;
    }
}

// Custom type for beforeinstallprompt event
export interface BeforeInstallPromptEvent extends Event {
    readonly platforms: string[];
    readonly userChoice: Promise<{
        outcome: "accepted" | "dismissed";
        platform: string;
    }>;
    prompt(): Promise<void>;
}

class PWAStore {
    deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);

    init() {
        if (!browser) return;

        // Check if event was already captured in app.html
        if (window.deferredPromptEvent) {
            this.deferredPrompt = window.deferredPromptEvent;
        }

        window.addEventListener("beforeinstallprompt", (e) => {
            // Prevent the mini-infobar from appearing on mobile
            e.preventDefault();
            // Stash the event so it can be triggered later.
            this.deferredPrompt = e as BeforeInstallPromptEvent;
            window.deferredPromptEvent = this.deferredPrompt;
        });

        // Optionally, once the application is installed we can drop the prompt
        window.addEventListener("appinstalled", () => {
            this.deferredPrompt = null;
        });
    }

    async promptInstall() {
        if (!this.deferredPrompt) return false;

        const promptEvent = this.deferredPrompt;
        await promptEvent.prompt();
        const result = await promptEvent.userChoice;

        if (result.outcome === "accepted") {
            this.deferredPrompt = null;
        }

        return result.outcome === "accepted";
    }
}

export const pwaStore = new PWAStore();
