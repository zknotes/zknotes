class AuthStore {
    // Svelte 5 runes
    isChecking = $state(true);
    isAuthenticated = $state(false);
    isVaultUnlocked = $state(false);

    setAuthenticated(auth: boolean) {
        this.isAuthenticated = auth;
    }

    setUnlocked(unlocked: boolean) {
        this.isVaultUnlocked = unlocked;
    }

    logout() {
        this.isAuthenticated = false;
        this.isVaultUnlocked = false;
    }
}

export const authStore = new AuthStore();
