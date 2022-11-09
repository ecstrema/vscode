/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import * as dom from 'vs/base/browser/dom';
import { IAnchor } from 'vs/base/browser/ui/contextview/contextview';
import { KeybindingLabel } from 'vs/base/browser/ui/keybindingLabel/keybindingLabel';
import { IListEvent, IListMouseEvent, IListRenderer, IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { List } from 'vs/base/browser/ui/list/listWidget';
import { IAction } from 'vs/base/common/actions';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { OS } from 'vs/base/common/platform';
import { localize } from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { Codicon } from 'vs/base/common/codicons';
import { ActionSet } from 'vs/base/common/actionWidget/actionWidget';
import 'vs/css!./actionWidget';
import { createDecorator, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { Action2, registerAction2 } from 'vs/platform/actions/common/actions';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';

export const Context = {
	Visible: new RawContextKey<boolean>('codeActionMenuVisible', false, localize('codeActionMenuVisible', "Whether the code action list widget is visible"))
};
export interface IRenderDelegate<T> {
	onHide(cancelled: boolean): void;
	onSelect(action: T, trigger: any, preview?: boolean): Promise<any>;
}

export interface ActionShowOptions {
	readonly includeDisabledActions: boolean;
	readonly fromLightbulb?: boolean;
	readonly showHeaders?: boolean;
}

export interface ListMenuItem<T> {
	item?: T;
	kind?: any;
	group?: any;
	disabled?: boolean | string;
	label?: string;
}

export interface IActionList<T> extends IDisposable {
	hide(): void;
	focusPrevious(): void;
	focusNext(): void;
	layout(minWidth: number): void;
	toMenuItems(items: readonly T[], showHeaders: boolean): ListMenuItem<T>[];
	acceptSelected(preview?: boolean): void;
	domNode: HTMLElement;
}

export interface IActionMenuTemplateData {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly text: HTMLElement;
	readonly keybinding: KeybindingLabel;
}

export enum ActionListItemKind {
	Action = 'action',
	Header = 'header'
}

interface HeaderTemplateData {
	readonly container: HTMLElement;
	readonly text: HTMLElement;
}

export class HeaderRenderer<T extends ListMenuItem<T>> implements IListRenderer<T, HeaderTemplateData> {

	get templateId(): string { return ActionListItemKind.Header; }

	renderTemplate(container: HTMLElement): HeaderTemplateData {
		container.classList.add('group-header');

		const text = document.createElement('span');
		container.append(text);

		return { container, text };
	}

	renderElement(element: ListMenuItem<T>, _index: number, templateData: HeaderTemplateData): void {
		templateData.text.textContent = element.group.title;
	}

	disposeTemplate(_templateData: HeaderTemplateData): void {
		// noop
	}
}


export class ActionItemRenderer<T extends ListMenuItem<T>> implements IListRenderer<T, IActionMenuTemplateData> {

	get templateId(): string { return 'action'; }

	constructor(@IKeybindingService private readonly _keybindingService: IKeybindingService,
		private readonly _resolver?: any) {
	}

	renderTemplate(container: HTMLElement): IActionMenuTemplateData {
		container.classList.add(this.templateId);

		const icon = document.createElement('div');
		icon.className = 'icon';
		container.append(icon);

		const text = document.createElement('span');
		text.className = 'title';
		container.append(text);

		const keybinding = new KeybindingLabel(container, OS);

		return { container, icon, text, keybinding };
	}

	renderElement(element: T, _index: number, data: IActionMenuTemplateData): void {
		if (element.group.icon) {
			data.icon.className = element.group.icon.codicon.classNames;
			data.icon.style.color = element.group.icon.color ?? '';
		} else {
			data.icon.className = Codicon.lightBulb.classNames;
			data.icon.style.color = 'var(--vscode-editorLightBulb-foreground)';
		}
		if (!element.item || !element.label) {
			return;
		}
		data.text.textContent = stripNewlines(element.label);
		let binding;
		if (this._resolver) {
			binding = this._resolver?.getResolver()((element.item as any).action);
		}
		data.keybinding.set(binding);
		if (!binding) {
			dom.hide(data.keybinding.element);
		} else {
			dom.show(data.keybinding.element);
		}

		if (element.disabled) {
			data.container.title = element.label;
			data.container.classList.add('option-disabled');
		} else {
			data.container.title = localize({ key: 'label', comment: ['placeholders are keybindings, e.g "F2 to Apply, Shift+F2 to Preview"'] }, "{0} to Apply, {1} to Preview", this._keybindingService.lookupKeybinding('acceptSelectedCodeAction')?.getLabel(), this._keybindingService.lookupKeybinding('previewSelectedCodeAction')?.getLabel());
			data.container.classList.remove('option-disabled');
		}
	}
	disposeTemplate(_templateData: IActionMenuTemplateData): void {
		// noop
	}
}

export const IActionWidgetService = createDecorator<IActionWidgetService>('actionWidgetService');
export interface IActionWidgetService {
	_serviceBrand: undefined;
	show(trigger: any, list: ActionList<any>, actions: ActionSet<any>, anchor: IAnchor, container: HTMLElement | undefined, options: ActionShowOptions, delegate: IRenderDelegate<any>): Promise<void>;
	hide(): void;
	isVisible: boolean;
	acceptSelected(preview?: boolean): void;
	focusPrevious(): void;
	focusNext(): void;
}

export class ActionWidgetService extends Disposable implements IActionWidgetService {
	readonly _serviceBrand: undefined;
	get isVisible() { return Context.Visible.getValue(this._contextKeyService) || false; }
	public showDisabled = false;
	currentShowingContext?: {
		readonly options: ActionShowOptions;
		readonly trigger: any;
		readonly anchor: IAnchor;
		readonly container: HTMLElement | undefined;
		readonly actions: ActionSet<any>;
		readonly delegate: IRenderDelegate<any>;
	};
	public list = this._register(new MutableDisposable<ActionList<any>>());
	constructor(@ICommandService readonly _commandService: ICommandService,
		@IContextViewService readonly contextViewService: IContextViewService,
		@IKeybindingService  readonly keybindingService: IKeybindingService,
		@ITelemetryService readonly _telemetryService: ITelemetryService,
		@IContextKeyService readonly _contextKeyService: IContextKeyService) {
		super();

	}

	public async show(trigger: any, list: ActionList<any>, actions: ActionSet<any>, anchor: IAnchor, container: HTMLElement | undefined, options: ActionShowOptions, delegate: IRenderDelegate<any>): Promise<void> {
		this.currentShowingContext = undefined;
		const visibleContext = Context.Visible.bindTo(this._contextKeyService);

		const actionsToShow = options.includeDisabledActions && (this.showDisabled || actions.validActions.length === 0) ? actions.allActions : actions.validActions;
		if (!actionsToShow.length) {
			visibleContext.reset();
			return;
		}

		this.currentShowingContext = { trigger, actions, anchor, container, delegate, options };

		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			render: (container: HTMLElement) => {
				visibleContext.set(true);
				return this._renderWidget(container, list, trigger, actions, options, delegate);
			},
			onHide: (didCancel: boolean) => {
				visibleContext.reset();
				return this._onWidgetClosed(trigger, options, actions, didCancel, delegate);
			},
		}, container, false);
	}

	acceptSelected(preview?: boolean) {
		this.list.value?.acceptSelected(preview);
	}

	focusPrevious() {
		this.list?.value?.focusPrevious();
	}

	focusNext() {
		this.list?.value?.focusNext();
	}

	hide() {
		this.list.value?.hide();
		this.list.clear();
	}

	clear() {
		this.list.clear();
	}

	private _renderWidget(element: HTMLElement, list: ActionList<any>, trigger: any, actions: ActionSet<any>, options: any, delegate: IRenderDelegate<any>): IDisposable {
		const widget = document.createElement('div');
		widget.classList.add('actionWidget');
		element.appendChild(widget);

		this.list.value = list;
		if (this.list.value) {
			widget.appendChild(this.list.value.domNode);
		} else {
			throw new Error('List has no value');
		}
		const renderDisposables = new DisposableStore();

		// Invisible div to block mouse interaction in the rest of the UI
		const menuBlock = document.createElement('div');
		const block = element.appendChild(menuBlock);
		block.classList.add('context-view-block');
		block.style.position = 'fixed';
		block.style.cursor = 'initial';
		block.style.left = '0';
		block.style.top = '0';
		block.style.width = '100%';
		block.style.height = '100%';
		block.style.zIndex = '-1';
		renderDisposables.add(dom.addDisposableListener(block, dom.EventType.MOUSE_DOWN, e => e.stopPropagation()));

		// Invisible div to block mouse interaction with the menu
		const pointerBlockDiv = document.createElement('div');
		const pointerBlock = element.appendChild(pointerBlockDiv);
		pointerBlock.classList.add('context-view-pointerBlock');
		pointerBlock.style.position = 'fixed';
		pointerBlock.style.cursor = 'initial';
		pointerBlock.style.left = '0';
		pointerBlock.style.top = '0';
		pointerBlock.style.width = '100%';
		pointerBlock.style.height = '100%';
		pointerBlock.style.zIndex = '2';

		// Removes block on click INSIDE widget or ANY mouse movement
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.POINTER_MOVE, () => pointerBlock.remove()));
		renderDisposables.add(dom.addDisposableListener(pointerBlock, dom.EventType.MOUSE_DOWN, () => pointerBlock.remove()));

		// Action bar
		let actionBarWidth = 0;
		if (!options.fromLightbulb) {
			const actionBar = this._createActionBar('.actionWidget-action-bar', actions, options);
			if (actionBar) {
				widget.appendChild(actionBar.getContainer().parentElement!);
				renderDisposables.add(actionBar);
				actionBarWidth = actionBar.getContainer().offsetWidth;
			}
		}

		const width = this.list.value?.layout(actionBarWidth);
		widget.style.width = `${width}px`;

		const focusTracker = renderDisposables.add(dom.trackFocus(element));
		renderDisposables.add(focusTracker.onDidBlur(() => this.hide()));

		return renderDisposables;
	}

	private _createActionBar(className: string, inputActions: ActionSet<any>, options: ActionShowOptions): ActionBar | undefined {
		const actions = this._getActionBarActions(inputActions, options);
		if (!actions.length) {
			return undefined;
		}

		const container = dom.$(className);
		const actionBar = new ActionBar(container);
		actionBar.push(actions, { icon: false, label: true });
		return actionBar;
	}
	private _getActionBarActions(actions: ActionSet<any>, options: ActionShowOptions): IAction[] {
		const resultActions = actions.documentation.map((command): IAction => ({
			id: command.id,
			label: command.title,
			tooltip: command.tooltip ?? '',
			class: undefined,
			enabled: true,
			run: () => this._commandService.executeCommand(command.id, ...(command.arguments ?? [])),
		}));

		if (options.includeDisabledActions && actions.validActions.length > 0 && actions.allActions.length !== actions.validActions.length) {
			resultActions.push(this.showDisabled ? {
				id: 'hideMoreActions',
				label: localize('hideMoreActions', 'Hide Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => this._toggleShowDisabled(false)
			} : {
				id: 'showMoreActions',
				label: localize('showMoreActions', 'Show Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => this._toggleShowDisabled(true)
			});
		}
		return resultActions;
	}
	/**
	 * Toggles whether the disabled actions in the action widget are visible or not.
	 */
	private _toggleShowDisabled(newShowDisabled: boolean): void {
		const previousCtx = this.currentShowingContext;

		this.hide();

		this.showDisabled = newShowDisabled;

		if (previousCtx) {
			this.show(previousCtx.trigger, this.list.value!, previousCtx.actions, previousCtx.anchor, previousCtx.container, previousCtx.options, previousCtx.delegate);
		}
	}

	private _onWidgetClosed(trigger: any, options: ActionShowOptions, actions: ActionSet<any>, didCancel: boolean, delegate: IRenderDelegate<any>): void {
		this.currentShowingContext = undefined;
		delegate.onHide(didCancel);
	}

}
registerSingleton(IActionWidgetService, ActionWidgetService, InstantiationType.Delayed);

export abstract class ActionList<T> extends Disposable implements IActionList<T> {

	public readonly domNode: HTMLElement;
	public list: List<ListMenuItem<T>>;

	readonly actionLineHeight = 24;
	readonly headerLineHeight = 26;

	private readonly allMenuItems: ListMenuItem<T>[];

	private focusCondition(element: ListMenuItem<T>): boolean {
		return !element.disabled && element.kind === ActionListItemKind.Action;
	}

	constructor(
		user: string,
		items: readonly T[],
		showHeaders: boolean,
		private readonly onDidSelect: (action: T, preview?: boolean) => void,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService
	) {
		super();
		this.domNode = document.createElement('div');
		this.domNode.classList.add('actionList');
		const virtualDelegate: IListVirtualDelegate<ListMenuItem<T>> = {
			getHeight: element => element.kind === 'header' ? this.headerLineHeight : this.actionLineHeight,
			getTemplateId: element => element.kind
		};
		this.list = new List(user, this.domNode, virtualDelegate, [new ActionItemRenderer<any>(this._keybindingService), new HeaderRenderer()], {
			keyboardSupport: true,
			accessibilityProvider: {
				getAriaLabel: element => {
					if (element.kind === 'action') {
						let label = element.label ? stripNewlines(element?.label) : '';
						if (element.disabled) {
							label = localize({ key: 'customQuickFixWidget.labels', comment: [`${user} labels for accessibility.`] }, "{0}, Disabled Reason: {1}", label, element.disabled);
						}
						return label;
					}
					return null;
				},
				getWidgetAriaLabel: () => localize({ key: 'customQuickFixWidget', comment: [`A ${user} option`] }, "Quick Fix Widget"),
				getRole: () => 'option',
				getWidgetRole: () => user
			},
		});

		this._register(this.list.onMouseClick(e => this.onListClick(e)));
		this._register(this.list.onMouseOver(e => this.onListHover(e)));
		this._register(this.list.onDidChangeFocus(() => this.list.domFocus()));
		this._register(this.list.onDidChangeSelection(e => this.onListSelection(e)));

		this.allMenuItems = this.toMenuItems(items, showHeaders);
		this.list.splice(0, this.list.length, this.allMenuItems);
		this.focusNext();
	}

	public hide(): void {
		this._contextViewService.hideContextView();
	}

	public layout(minWidth: number): number {
		// Updating list height, depending on how many separators and headers there are.
		const numHeaders = this.allMenuItems.filter(item => item.kind === 'header').length;
		const height = this.allMenuItems.length * this.actionLineHeight;
		const heightWithHeaders = height + numHeaders * this.headerLineHeight - numHeaders * this.actionLineHeight;
		this.list.layout(heightWithHeaders);

		// For finding width dynamically (not using resize observer)
		const itemWidths: number[] = this.allMenuItems.map((_, index): number => {
			const element = document.getElementById(this.list.getElementID(index));
			if (element) {
				element.style.width = 'auto';
				const width = element.getBoundingClientRect().width;
				element.style.width = '';
				return width;
			}
			return 0;
		});

		// resize observer - can be used in the future since list widget supports dynamic height but not width
		const width = Math.max(...itemWidths, minWidth);
		this.list.layout(heightWithHeaders, width);

		this.domNode.style.height = `${heightWithHeaders}px`;

		this.list.domFocus();
		return width;
	}

	public focusPrevious() {
		this.list.focusPrevious(1, true, undefined, this.focusCondition);
	}

	public focusNext() {
		this.list.focusNext(1, true, undefined, this.focusCondition);
	}

	public acceptSelected(preview?: boolean) {
		const focused = this.list.getFocus();
		if (focused.length === 0) {
			return;
		}

		const focusIndex = focused[0];
		const element = this.list.element(focusIndex);
		if (!this.focusCondition(element)) {
			return;
		}

		const event = new UIEvent(preview ? 'previewSelectedAction' : 'acceptSelectedAction');
		this.list.setSelection([focusIndex], event);
	}

	private onListSelection(e: IListEvent<ListMenuItem<T>>): void {
		if (!e.elements.length) {
			return;
		}

		const element = e.elements[0];
		if (element.item && this.focusCondition(element)) {
			this.onDidSelect(element.item, e.browserEvent?.type === 'previewSelectedEventType');
		} else {
			this.list.setSelection([]);
		}
	}

	private onListHover(e: IListMouseEvent<ListMenuItem<T>>): void {
		this.list.setFocus(typeof e.index === 'number' ? [e.index] : []);
	}

	private onListClick(e: IListMouseEvent<ListMenuItem<T>>): void {
		if (e.element && this.focusCondition(e.element)) {
			this.list.setFocus([]);
		}
	}
	public abstract toMenuItems(inputActions: readonly T[], showHeaders: boolean): ListMenuItem<T>[];
}

export function stripNewlines(str: string): string {
	return str.replace(/\r\n|\r|\n/g, ' ');
}

const weight = KeybindingWeight.EditorContrib + 1000;

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hideCodeActionWidget',
			title: {
				value: localize('hideCodeActionWidget.title', "Hide code action widget"),
				original: 'Hide code action widget'
			},
			precondition: Context.Visible,
			keybinding: {
				weight,
				primary: KeyCode.Escape,
				secondary: [KeyMod.Shift | KeyCode.Escape]
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).hide();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'selectPrevCodeAction',
			title: {
				value: localize('selectPrevCodeAction.title', "Select previous code action"),
				original: 'Select previous code action'
			},
			precondition: Context.Visible,
			keybinding: {
				weight,
				primary: KeyCode.UpArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow],
				mac: { primary: KeyCode.UpArrow, secondary: [KeyMod.CtrlCmd | KeyCode.UpArrow, KeyMod.WinCtrl | KeyCode.KeyP] },
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).focusPrevious();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'selectNextCodeAction',
			title: {
				value: localize('selectNextCodeAction.title', "Select next code action"),
				original: 'Select next code action'
			},
			precondition: Context.Visible,
			keybinding: {
				weight,
				primary: KeyCode.DownArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.DownArrow],
				mac: { primary: KeyCode.DownArrow, secondary: [KeyMod.CtrlCmd | KeyCode.DownArrow, KeyMod.WinCtrl | KeyCode.KeyN] }
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).focusNext();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'acceptSelectedCodeAction',
			title: {
				value: localize('acceptSelected.title', "Accept selected code action"),
				original: 'Accept selected code action'
			},
			precondition: Context.Visible,
			keybinding: {
				weight,
				primary: KeyCode.Enter,
				secondary: [KeyMod.CtrlCmd | KeyCode.Period],
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).acceptSelected();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'previewSelectedCodeAction',
			title: {
				value: localize('previewSelected.title', "Preview selected code action"),
				original: 'Preview selected code action'
			},
			precondition: Context.Visible,
			keybinding: {
				weight,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
			}
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IActionWidgetService).acceptSelected(true);
	}
});
