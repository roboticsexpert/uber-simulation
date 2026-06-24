import { Engine } from "./engine.js";

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

  create(): { id: string; engine: Engine } {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`سقفِ ${MAX_SESSIONS} سشن پر است`);
    }
    let id = randomName();
    while (this.sessions.has(id)) id = randomName(); // جلوگیری از تصادم
    const engine = new Engine();
    this.sessions.set(id, engine);
    return { id, engine };
  }

  get(id: string): Engine | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): boolean {
    const engine = this.sessions.get(id);
    if (!engine) return false;
    engine.reset(); // تایمر را متوقف می‌کند
    return this.sessions.delete(id);
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
