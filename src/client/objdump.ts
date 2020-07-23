import { VsCodeApi } from "./vscodeApi";
import styles from './objdump.module.css';

// based on https://github.com/microsoft/vscode/blob/master/src/vs/base/common/scrollable.ts
// TODO: simplify, refactor
interface ISmoothScrollPosition {
	readonly scrollTop: number;
	readonly height: number;
}

export interface INewScrollDimensions {
	height: number;
	scrollHeight: number;
}

class SmoothScrollingUpdate {
	public readonly scrollTop: number;
	public readonly isDone: boolean;

	constructor(scrollTop: number, isDone: boolean) {
		this.scrollTop = scrollTop;
		this.isDone = isDone;
	}
}

type IAnimation = (completion: number) => number;

function createEaseOutCubic(from: number, to: number): IAnimation {
	const delta = to - from;
	return (completion: number): number => {
		return from + delta * easeOutCubic(completion);
	};
}

function createComposed(a: IAnimation, b: IAnimation, cut: number): IAnimation {
	return (completion: number): number => {
		if (completion < cut) {
			return a(completion / cut);
		}
		return b((completion - cut) / (1 - cut));
	};
}

class SmoothScrollingOperation {
	public readonly from: ISmoothScrollPosition;
	public to: ISmoothScrollPosition;
	public readonly duration: number;
	private readonly startTime: number;
	public animationFrameDisposable: number;
	private scrollTop!: IAnimation;

	protected constructor(from: ISmoothScrollPosition, to: ISmoothScrollPosition, startTime: number, duration: number) {
		this.from = from;
		this.to = to;
		this.duration = duration;
		this.startTime = startTime;

		this.initAnimations();
	}

	private initAnimations(): void {
		this.scrollTop = this.initAnimation(this.from.scrollTop, this.to.scrollTop, this.to.height);
	}

	private initAnimation(from: number, to: number, viewportSize: number): IAnimation {
		const delta = Math.abs(from - to);
		if (delta > 2.5 * viewportSize) {
			let stop1: number, stop2: number;
			if (from < to) {
				// scroll to 75% of the viewportSize
				stop1 = from + 0.75 * viewportSize;
				stop2 = to - 0.75 * viewportSize;
			} else {
				stop1 = from - 0.75 * viewportSize;
				stop2 = to + 0.75 * viewportSize;
			}
			return createComposed(createEaseOutCubic(from, stop1), createEaseOutCubic(stop2, to), 0.33);
		}
		return createEaseOutCubic(from, to);
	}

	public acceptScrollDimensions(state: ScrollState): void {
		this.to = state.withScrollPosition(this.to.scrollTop);
		this.initAnimations();
	}	

	public tick(): SmoothScrollingUpdate {
		return this._tick(Date.now());
	}

	protected _tick(now: number): SmoothScrollingUpdate {
		const completion = (now - this.startTime) / this.duration;

		if (completion < 1) {
			const newScrollTop = this.scrollTop(completion);
			return new SmoothScrollingUpdate(newScrollTop, false);
		}

		return new SmoothScrollingUpdate(this.to.scrollTop, true);
	}

	public combine(from: ISmoothScrollPosition, to: ISmoothScrollPosition, duration: number): SmoothScrollingOperation {
		return SmoothScrollingOperation.start(from, to, duration);
	}

	public static start(from: ISmoothScrollPosition, to: ISmoothScrollPosition, duration: number): SmoothScrollingOperation {
		// +10 / -10 : pretend the animation already started for a quicker response to a scroll request
		duration = duration + 10;
		const startTime = Date.now() - 10;

		return new SmoothScrollingOperation(from, to, startTime, duration);
	}
}

function easeInCubic(t: number) {
	return Math.pow(t, 3);
}

function easeOutCubic(t: number) {
	return 1 - easeInCubic(1 - t);
}

class ScrollState {
	public readonly height: number;
	public readonly scrollHeight: number;
	public readonly scrollTop: number;

	constructor(height: number, scrollHeight: number, scrollTop: number) {
		height = height | 0;
		scrollHeight = scrollHeight | 0;
		scrollTop = scrollTop | 0;

		if (height < 0) {
			height = 0;
		}
		if (scrollTop + height > scrollHeight) {
			scrollTop = scrollHeight - height;
		}
		if (scrollTop < 0) {
			scrollTop = 0;
		}

		this.height = height;
		this.scrollHeight = scrollHeight;
		this.scrollTop = scrollTop;		
	}

	public withScrollDimensions(update: INewScrollDimensions, useRawScrollPositions: boolean): ScrollState {
		return new ScrollState(update.height, update.scrollHeight, this.scrollTop);
	}

	public withScrollPosition(update: number): ScrollState {
		return new ScrollState(this.height, this.scrollHeight, update);
	}

	public equals(other: ScrollState): boolean {
		return (
			   this.height === other.height
			&& this.scrollHeight === other.scrollHeight
			&& this.scrollTop === other.scrollTop
		);
	}
}

class Scrollable {
	private state: ScrollState;
	private smoothScrolling: SmoothScrollingOperation = null;

	constructor(private container: HTMLElement, private smoothScrollDuration: number) {
		console.log(container.clientHeight, container.scrollHeight);
		this.state = new ScrollState(container.clientHeight, container.scrollHeight, 0);
	}

	public setScrollDimensions(dimensions: INewScrollDimensions, useRawScrollPositions: boolean): void {
		const newState = this.state.withScrollDimensions(dimensions, useRawScrollPositions);
		this.setState(newState);

		// Validate outstanding animated scroll position target
		if (this.smoothScrolling) {
			this.smoothScrolling.acceptScrollDimensions(this.state);
		}
	}

	public setScrollPositionNow(update: number): void {
		// no smooth scrolling requested
		const newState = this.state.withScrollPosition(update);

		// Terminate any outstanding smooth scrolling
		this.smoothScrolling = null;
		this.setState(newState);
	}

	public setScrollPositionSmooth(update: number): void {
		if (this.smoothScrollDuration === 0) {
			// Smooth scrolling not supported.
			return this.setScrollPositionNow(update);
		}

		if (this.smoothScrolling) {
			// Validate `update`
			const validTarget = this.state.withScrollPosition(update);

			if (this.smoothScrolling.to.scrollTop === validTarget.scrollTop) {
				// No need to interrupt or extend the current animation since we're going to the same place
				return;
			}

			const newSmoothScrolling = this.smoothScrolling.combine(this.state, validTarget, this.smoothScrollDuration);
			this.smoothScrolling = newSmoothScrolling;
		} else {
			// Validate `update`
			const validTarget = this.state.withScrollPosition(update);

			this.smoothScrolling = SmoothScrollingOperation.start(this.state, validTarget, this.smoothScrollDuration);
		}

		// Begin smooth scrolling animation
		this.smoothScrolling.animationFrameDisposable = window.requestAnimationFrame(() => {
			if (!this.smoothScrolling) {
				return;
			}
			this.smoothScrolling.animationFrameDisposable = undefined;
			this.performSmoothScrolling();
		});
	}

	private performSmoothScrolling(): void {
		if (!this.smoothScrolling) {
			return;
		}
		const update = this.smoothScrolling.tick();
		const newState = this.state.withScrollPosition(update.scrollTop);

		this.setState(newState);

		if (!this.smoothScrolling) {
			// Looks like someone canceled the smooth scrolling
			// from the scroll event handler
			return;
		}

		if (update.isDone) {
			this.smoothScrolling = null;
			return;
		}

		// Continue smooth scrolling animation
		this.smoothScrolling.animationFrameDisposable = window.requestAnimationFrame(() => {
			if (!this.smoothScrolling) {
				return;
			}
			this.smoothScrolling.animationFrameDisposable = undefined;
			this.performSmoothScrolling();
		});
	}

	private setState(newState: ScrollState): void {
		const oldState = this.state;
		if (oldState.equals(newState)) {
			// no change
			return;
		}
		this.state = newState;
		this.container.scrollTop = newState.scrollTop;
		//this._onScroll.fire(this._state.createScrollEvent(oldState));
	}
}

// messages from webview to vs code
export interface IOpenDocumentMessage {
	type: 'openDocument';
	file: string;
	line: number;
}

interface Location {
	file: string;
	line: number;
}

declare const OBJDUMP: string;

export async function Objdump() {
	const container = document.createElement('div');
	container.className = styles.container;

	const lines = OBJDUMP.replace(/\r/g, '').split('\n');
	const rows: HTMLDivElement[] = [];
	const locations: Location[] = [];
	let location: Location = { file: '', line: -1 };
	for(const line of lines) {
		const match = line.match(/^(\S.+):([0-9]+)( \(discriminator [0-9]+\))?$/);
		if(match) {
			location = {
				file: match[1],
				line: parseInt(match[2])
			};
			continue;
		}
		const row = document.createElement('div');
		row.attributes['data-row'] = rows.length;
		row.innerText = line.length > 0 ? line : '\u200b';
		container.appendChild(row);
		rows.push(row);
		locations.push({ ...location });
	}
	document.body.appendChild(container);

	let curRow = 0;
	rows[curRow].className = styles.cur;

	window.requestAnimationFrame(() => { // wait until layout has been calculated so we know the height of the content
		const scroller = new Scrollable(document.documentElement, 135);
		const selectRow = (nextRow: number, scroll: boolean) => {
			if(nextRow === curRow)
				return;
			rows[curRow].className = '';
			rows[nextRow].className = styles.cur;
			if(scroll) {
				const scrollTo = rows[nextRow].offsetTop - document.documentElement.clientHeight / 2;
				if(Math.abs(nextRow - curRow) > 1)
					scroller.setScrollPositionSmooth(scrollTo);
				else
					scroller.setScrollPositionNow(scrollTo);
			}
			curRow = nextRow;

			if(locations[curRow].file !== '') {
				VsCodeApi.postMessage<IOpenDocumentMessage>({
					type: 'openDocument',
					file: locations[curRow].file,
					line: locations[curRow].line
				});
			}
		};

		document.addEventListener('keydown', (evt: KeyboardEvent) => {
			let nextRow = curRow;
			if(evt.key === 'ArrowDown')
				nextRow = Math.min(rows.length - 1, curRow + 1);
			else if(evt.key === 'ArrowUp')
				nextRow = Math.max(0, curRow - 1);
			else if(evt.key === 'PageDown')
				nextRow = Math.min(rows.length - 1, Math.floor(curRow + (window.innerHeight / rows[curRow].clientHeight * 0.9)));
			else if(evt.key === 'PageUp')
				nextRow = Math.max(0, Math.floor(curRow - (window.innerHeight / rows[curRow].clientHeight * 0.9)));
			else if(evt.key === 'Home')
				nextRow = 0;
			else if(evt.key === 'End')
				nextRow = rows.length - 1;
			selectRow(nextRow, true);
			evt.preventDefault();
		});
		container.onclick = (evt: MouseEvent) => {
			const elem = evt.srcElement as HTMLElement;
			const row = elem.attributes['data-row'];
			if(row !== undefined) {
				selectRow(row, false);
			}
		};
	});
}
