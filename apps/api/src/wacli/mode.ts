import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AppSettings {
  readOnly: boolean;
  storeDir?: string;
  account?: string;
}

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
          readOnly: parsed.readOnly !== undefined ? Boolean(parsed.readOnly) : false,
          storeDir: parsed.storeDir,
          account: parsed.account,
        };
      }
    } catch {
      // fallback to default
    }

    return { readOnly: false };
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
    this.settings = { ...this.settings, ...partial };
    this.saveSettings();
    return { ...this.settings };
  }
}

export const modeManager = new ModeManager();
