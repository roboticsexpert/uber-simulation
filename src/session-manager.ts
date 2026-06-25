import { Engine } from "./engine.js";
import { config } from "./config.js";
import type { SessionResult, SessionStore } from "./store.js";

const MAX_SESSIONS = 16;

// اجزای اسم‌های رندومِ خوانا (ASCII، مناسبِ URL و SESSION_ID)
const ADJ = ["brave", "calm", "swift", "lucky", "bold", "wise", "keen", "wild", "fancy", "noble", "quiet", "sunny", "merry", "clever", "jolly", "spry"];
const NOUN = ["fox", "otter", "hawk", "wolf", "lynx", "puma", "crane", "raven", "tiger", "panda", "moose", "bison", "heron", "koala", "gecko", "ibex"];

function randomName(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const suffix = Math.floor(Math.random() * 1000).toString(36);
  return `${a}-${n}-${suffix}`;
}

/**
 * چندین Engine مستقل را هم‌زمان نگه می‌دارد.
 * همهٔ سشن‌ها از یک config سراسری (همان seed و پارامترها) استفاده می‌کنند،
 * پس دنیای اولیه و تقاضای یکسانی دارند؛ تنها تفاوت‌شان از تصمیمِ Matcher می‌آید.
 */
export class SessionManager {
  private sessions = new Map<string, Engine>();
  /** تایمرهای پاک‌سازیِ سشن‌های تمام‌شده — تا هنگام حذفِ زودهنگام لغوشان کنیم. */
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** هنگام حذفِ سشن صدا زده می‌شود (مثلاً برای بستنِ WebSocketها). */
  onEvict?: (id: string) => void;

  constructor(private store: SessionStore) {}

  create(name: string): { id: string; engine: Engine } {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`سقفِ ${MAX_SESSIONS} سشن پر است`);
    }
    let id = randomName();
    while (this.sessions.has(id)) id = randomName(); // جلوگیری از تصادم
    const engine = new Engine();
    engine.creator = name; // نامِ سازنده (اجباری)
    // وقتی سشن تمام شد: نتیجه را آرشیو کن، سپس برای آزادسازیِ حافظه از Map پاکش کن.
    engine.onFinish = () => {
      this.store.saveResult(this.buildResult(id, engine)).catch((e) =>
        console.error(`ذخیرهٔ نتیجهٔ سشن ${id} ناموفق بود:`, e),
      );
      this.scheduleEviction(id);
    };
    this.sessions.set(id, engine);
    return { id, engine };
  }

  /**
   * سشنِ تمام‌شده را پس از یک مهلت از حافظه پاک می‌کند تا نشتی نداشته باشیم.
   * مهلت فرصت می‌دهد UI وضعیتِ نهایی را نشان دهد؛ با ttl=0 حذف فوری است.
   */
  private scheduleEviction(id: string): void {
    if (this.evictionTimers.has(id)) return; // قبلاً زمان‌بندی شده
    const ttl = config.finishedSessionTtlMs;
    if (ttl <= 0) {
      this.remove(id);
      return;
    }
    const timer = setTimeout(() => {
      this.evictionTimers.delete(id);
      this.remove(id);
    }, ttl);
    timer.unref?.(); // نگذار این تایمر مانع خاموش‌شدنِ پروسه شود
    this.evictionTimers.set(id, timer);
  }

  /** نتیجهٔ نهاییِ سشن را از وضعیتِ فعلیِ engine می‌سازد. */
  private buildResult(id: string, engine: Engine): SessionResult {
    const v = engine.vizState();
    return {
      id,
      creator: engine.creator,
      ticks: v.tick,
      seed: config.seed,
      scoreboard: v.scoreboard,
      config: { ...config },
    };
  }

  get(id: string): Engine | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): boolean {
    const engine = this.sessions.get(id);
    if (!engine) return false;
    const timer = this.evictionTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(id);
    }
    engine.stop(); // تایمرِ cycle را متوقف می‌کند
    // ارجاع‌های callback را قطع کن تا چیزی مانعِ آزادسازیِ engine نشود.
    engine.onSnapshot = undefined;
    engine.onFinish = undefined;
    const deleted = this.sessions.delete(id);
    if (deleted) this.onEvict?.(id); // بستنِ WebSocketهای این سشن
    return deleted;
  }

  /** خلاصهٔ کاملِ همهٔ سشن‌ها (vizState هر کدام + id). */
  listViz(): Array<{ id: string } & ReturnType<Engine["vizState"]>> {
    return [...this.sessions.entries()].map(([id, engine]) => ({
      id,
      ...engine.vizState(),
    }));
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }
}
