import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AppSettings {
  readOnly: boolean;
  storeDir?: string;
  account?: string;
}

/**
 * Safe mode is only imposed before the operator has made a choice. Once they
 * unlock live sends we persist that and never re-impose the lock on them.
 */
export const FIRST_RUN_READ_ONLY = true;

export class ModeManager {
  private settingsFilePath: string;
  private settings: AppSettings;

  constructor(customPath?: string) {
    if (customPath) {
      this.settingsFilePath = customPath;
    } else if (process.env.WACLI_SETTINGS_FILE) {
      this.settingsFilePath = process.env.WACLI_SETTINGS_FILE;
    } else {
      let configDir = path.join(os.homedir(), '.wacli-mission-control');
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }
      } catch {
        configDir = path.join(process.cwd(), '.wacli-mission-control');
        try {
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
          }
        } catch {
          configDir = os.tmpdir();
        }
      }
      this.settingsFilePath = path.join(configDir, 'settings.json');
    }

    this.settings = this.loadSettings();
  }

  private loadSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return {
          // A stored choice always wins, so the operator's decision survives restarts.
          readOnly: parsed.readOnly !== undefined ? Boolean(parsed.readOnly) : FIRST_RUN_READ_ONLY,
          storeDir: parsed.storeDir,
          account: parsed.account,
        };
      }
    } catch {
      // fallback to default
    }

    // No settings file yet: this is a first run, so start locked.
    return { readOnly: FIRST_RUN_READ_ONLY };
  }

  private saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(this.settings, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      console.warn('Failed to persist settings:', err);
    }
  }

  public isReadOnly(): boolean {
    return this.settings.readOnly;
  }

  public setReadOnly(readOnly: boolean): void {
    this.settings.readOnly = readOnly;
    this.saveSettings();
  }

  public getSettings(): AppSettings {
    return { ...this.settings };
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    // Spreading the raw partial would let an explicit `undefined` (a field the
    // caller simply did not set) erase a stored value — which previously wiped
    // `readOnly` off disk whenever settings were saved without it.
    const next = { ...this.settings };
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        (next as Record<string, unknown>)[key] = value;
      }
    }
    this.settings = next;
    this.saveSettings();
    return { ...this.settings };
  }
}

export const modeManager = new ModeManager();
