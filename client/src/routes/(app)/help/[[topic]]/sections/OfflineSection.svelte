<script lang="ts">
import { Database, Download } from "lucide-svelte";
</script>

<section>
    <h2 class="text-2xl font-bold text-[var(--text)] mb-4">Storage and Installation (Offline-First)</h2>
    <p class="text-[var(--text-muted)] text-sm mb-8">
        ZKnotes is a zero-knowledge app. Your notes are encrypted and decrypted only on your device — the server never sees your data in readable form. To keep everything working smoothly even without internet, the app uses advanced browser capabilities for local storage.
    </p>

    <div class="space-y-8">
        <div class="bg-[var(--surface-panel)] border border-[var(--stroke-soft)] rounded-2xl p-6 shadow-sm">
            <div class="flex items-center gap-3 mb-4">
                <div class="p-2 bg-amber-500/10 rounded-xl text-amber-500">
                    <Database class="w-5 h-5" />
                </div>
                <h3 class="text-lg font-medium text-[var(--text-sub)]">Why do I see the "Offline storage is not persistent" warning?</h3>
            </div>

            <div class="space-y-4 text-sm text-[var(--text-muted)] leading-relaxed">
                <p>
                    Modern browsers (Chrome, Safari, Firefox) have built-in mechanisms for managing disk space. If your computer or phone starts running low on free space, the browser may <strong>automatically delete data</strong> from websites it does not consider "important" — without asking you first.
                </p>
                <p>
                    If the browser clears our local database (IndexedDB), you will not lose your data — it remains safely stored (in encrypted form) on our server. However, you will lose the <strong>ability to read notes while offline</strong> until you reconnect to the internet and download them again.
                </p>
                <p>
                    To prevent this, you need to tell the browser that this data matters to you. The most reliable way is to <strong>install the app (PWA)</strong>.
                </p>
            </div>
        </div>

        <div class="bg-[var(--surface-panel)] border border-[var(--stroke-soft)] rounded-2xl p-6 shadow-sm">
            <div class="flex items-center gap-3 mb-4">
                <div class="p-2 bg-brand0/10 rounded-xl text-brand0">
                    <Download class="w-5 h-5" />
                </div>
                <h3 class="text-lg font-medium text-[var(--text-sub)]">Installing the app (PWA)</h3>
            </div>

            <div class="space-y-4 text-sm text-[var(--text-muted)] leading-relaxed">
                <p>
                    You can install ZKnotes directly from your browser. An installed app gets higher privileges: the browser stops clearing its data (it receives so-called "persistent storage"), opens in its own window (without the URL bar), and behaves like any other app on your device.
                </p>

                <div class="mt-6 space-y-4 border-l-2 border-[var(--stroke)] pl-4">
                    <div>
                        <strong class="text-[var(--text-sub)] block mb-1">Google Chrome & Microsoft Edge</strong>
                        <p>Full installation is supported on desktop and mobile. Go to <code class="bg-[var(--surface-raised)] px-1.5 py-0.5 rounded text-[var(--text-sub)] text-xs">Settings &gt; App Info</code> and look for the "Install App" button, or click the install icon in the browser's address bar.</p>
                    </div>
                    <div>
                        <strong class="text-[var(--text-sub)] block mb-1">Mozilla Firefox</strong>
                        <p>Firefox handles local storage well and often grants "persistent storage" automatically (which is why you rarely see the yellow warning there). However, <strong class="text-[var(--text-sub)]">Firefox on desktop deliberately does not support installing web apps</strong>. Because of this, the "Install App" button will never appear in Firefox — that is expected behavior.</p>
                    </div>
                    <div>
                        <strong class="text-[var(--text-sub)] block mb-1">Safari on iOS (iPhone / iPad)</strong>
                        <p>To install, open the "Share" menu at the bottom of the browser and choose <strong class="text-[var(--text-sub)]">"Add to Home Screen"</strong>. This is critical on Apple devices because Safari otherwise aggressively clears data older than 7 days.</p>
                    </div>
                </div>
            </div>
        </div>
    </div>
</section>