// What a page area of the terminal dashboard may do in response to its buttons.
// Each area (models, services, mesh, system sections…) is its own module with a
// page builder and an action handler; the runtime in tui.ts provides this context.
import type {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {Session} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {DialogSpec, FormField, MenuOption, TuiOverlay, ViewerSpec} from './tui-dialogs';
import type {OpenSpec, SaveSpec} from './tui-files';
import type {PageState} from './tui-state';

export interface PerformResult {
  lines?: string[];
  copyValue?: string;
}

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  /** Exact text to type first, for disruptive host operations (the computer name) and deletions. */
  expected?: string;
  danger?: boolean;
  /** Esc and Cancel return to the dialog that opened this confirmation. */
  back?: boolean;
}

export interface TuiContext {
  readonly api: MagicStickApi;
  /** Mutable view state: page, sections, expanded panels and per-page `ui` values (search, filters, paging). */
  readonly view: PageState;
  readonly demo: boolean;
  snapshot(): DashboardSnapshot;
  session(): Session;
  draw(): void;
  /** Reloads the shared state, including the data of the page that is open; `releases` also reloads the cached release catalog. */
  refresh(options?: {releases?: boolean}): Promise<void>;
  message(title: string, lines: string | string[], tone?: 'normal' | 'error', copyValue?: string): void;
  /**
   * Runs a change behind a busy dialog, reloads the state and reports the result.
   * A failure returns to the dialog or confirmation it came from, with the error shown there.
   */
  perform(title: string, operation: () => Promise<PerformResult | void>): Promise<void>;
  /** Runs a request behind a busy dialog and returns to the calling dialog (no completion message). */
  task<T>(title: string, operation: () => Promise<T>, then?: (value: T) => void): Promise<void>;
  /** Loads something to read behind a busy dialog, then hands it over (closing the busy dialog). */
  load<T>(title: string, fetch: () => Promise<T>, then: (value: T) => void): Promise<void>;
  confirm(options: ConfirmOptions): void;
  /** A simple list form: text, secret and choice fields, submitted together. */
  form(title: string, description: string, fields: FormField[], submitLabel: string, onSubmit: (values: Record<string, string>) => Promise<void>, back?: boolean): void;
  /** A dialog built from its own state on every render; see tui-dialogs.ts. */
  dialog(spec: DialogSpec, back?: boolean): void;
  menu(title: string, description: string | undefined, options: MenuOption[], active?: number, back?: boolean): void;
  viewer(spec: ViewerSpec, back?: boolean): void;
  /** The open dialog, if any (to return to it after a nested step). */
  current(): TuiOverlay | undefined;
  /** Closes the open dialog, returning to the one below it when it was stacked. */
  close(): void;
  /** Copies text with the terminal clipboard protocol (OSC 52). */
  copy(value: string): void;
  /**
   * The browser's download: asks where to save, then writes a new file (never overwriting).
   * In a terminal that is a local path; on the appliance monitor it is a USB stick.
   */
  saveAs(spec: SaveSpec): void;
  /** The browser's file input: a local path in a terminal, a file on a USB stick on the appliance monitor. */
  openFile(spec: OpenSpec): void;
  /** A fresh 32-character request id, as the browser sends for host operations. */
  requestId(): string;
  /** Message for an item that disappeared between rendering and pressing its button. */
  missing(): void;
}

export interface ActionRequest {
  id: string;
  scope: string;
  verb: string;
  target: string;
}

/** Who may trigger the actions of a scope; checked before the handler runs. Hiding a button is not authorization. */
export type ScopeAccess = 'any' | 'runtime' | 'admin';

export interface AreaModule {
  scopes: Record<string, ScopeAccess>;
  /** Actions that only read or change the view (info, refresh, search, paging); they also work in the offline demo. */
  readOnly?: (action: ActionRequest) => boolean;
  handle(ctx: TuiContext, action: ActionRequest): void | Promise<void>;
}
