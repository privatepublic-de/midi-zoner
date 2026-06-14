declare module 'electron-settings' {
  export function get(key: string): any;
  export function set(key: string, value: any): void;
  export function has(key: string): boolean;
  export function unset(key: string): void;
}
