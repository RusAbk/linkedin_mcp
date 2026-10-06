import type { CDPSession, Page } from "playwright";

/** Keeps only the newest Chrome frame. Reading acknowledges frames and allows
 * Chrome to render more; a hidden/disconnected viewer creates no frame backlog. */
export class LoginScreen {
  private session: CDPSession | null = null;
  private image: string | undefined;
  private version = 0;
  private readonly acknowledgements = new Set<number>();
  constructor(readonly page: Page) {}

  async start(): Promise<void> {
    await this.page.bringToFront();
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    session.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      if (this.session !== session) return;
      this.image = event.data;
      this.version++;
      this.acknowledgements.add(event.sessionId);
    });
    await session.send("Page.enable");
    await session.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1120, maxHeight: 778, everyNthFrame: 1 });
    // Native capture supplies the initial frame without Playwright's font wait.
    if (!this.image) {
      const initial = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 60, captureBeyondViewport: false });
      if (!this.image) { this.image = initial.data; this.version++; }
    }
  }

  read(): { image?: string; version: number } {
    const session = this.session;
    for (const sessionId of this.acknowledgements) {
      void session?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    }
    this.acknowledgements.clear();
    return { ...(this.image ? { image: this.image } : {}), version: this.version };
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.image = undefined;
    this.acknowledgements.clear();
    if (session) {
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    }
  }
}
