import {Observable, fromEvent, merge, timer, empty, queue} from 'rxjs';
import {map, mapTo, scan, tap} from 'rxjs/operators';

const FPS = 7.5;
const GRID_WIDTH = 10;
const GRID_HEIGHT = 20;
const N_BRICK_TYPES = 7;
const UNSPAWNED_POS = -Infinity;
const CELL_SIZE_PX = 15;
const QUEUE_SIZE = 4;
const BOARD_HTML_CHILDREN = 2;
const ROW_ANIMATION_FRAMES = 6;
const ROW_ANIMATION_INTERVAL = 2;
const POINTS_PER_ROW = 100;

const LOADING_ID = 'loading';
const START_GAME_ID = 'start-game';
const RESTART_GAME_ID = 'restart-game';
const UNSTARTED_ID = 'unstarted';
const IN_PROGRESS_ID = 'in-progress';
const GAME_OVER_ID = 'game-over';
const GAME_OVER_SCORE_ID = 'game-over-score';
const SIDEBAR_SCORE_ID = 'sidebar-score';
const BOARD_ID = 'board';
const FALLING_BRICK_ID = 'falling-brick';
const PROJECTION_ID = 'projection';

const CELL_CLASS = 'cell';
const ROW_ANIMATION_CELL_CLASS = 'animated-cell';
const HIDDEN_ELEM_CLASS = 'hidden';

/**
 * 7 canonical brick types of Tetris.
 */
enum BrickType {
    I = 0,
    L = 1,
    J = 2,
    O = 3,
    S = 4,
    Z = 5,
    T = 6,
}

const randomBrickType = (): BrickType =>
    Math.floor(Math.random() * N_BRICK_TYPES);

type Bit = 0 | 1;

type BrickShape = Bit[][];

/**
 * Map brick types to their shape.
 * This is only used for the falling brick.
 * When a brick lands it is written to a more
 * static data structure.
 */
const brickTypeToShapeMap: {[key in BrickType]?: BrickShape} = {
    [BrickType.I]: [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ],
    [BrickType.L]: [
        [1, 0, 0],
        [1, 1, 1],
        [0, 0, 0],
    ],
    [BrickType.J]: [
        [0, 0, 1],
        [1, 1, 1],
        [0, 0, 0],
    ],
    [BrickType.O]: [
        [1, 1],
        [1, 1],
    ],
    [BrickType.S]: [
        [0, 1, 1],
        [1, 1, 0],
        [0, 0, 0],
    ],
    [BrickType.Z]: [
        [1, 1, 0],
        [0, 1, 1],
        [0, 0, 0],
    ],
    [BrickType.T]: [
        [0, 1, 0],
        [1, 1, 1],
        [0, 0, 0],
    ],
};

const shapeSize = (b: BrickShape) => b.length;

const isEmptyBitGridRow = (b: BrickShape, y: number) => b[y].every(x => !x);

const copyBrickShape = (b: BrickShape) => {
    const size = shapeSize(b);
    return [...Array(size)].map(
        (_, y) => [...Array(size)].map((_, x) => b[y][x]));
};

enum Orientation {
    SPAWN = 0,
    RIGHT = 1,
    TWO = 2,
    LEFT = 3,
}

const incrementOrientation = (o: Orientation) => ((o + 1) % 4) as Orientation;

type NumPair = [number, number];

type WallKickList = [NumPair, NumPair, NumPair, NumPair, NumPair];

/**
 * Based on https://tetris.wiki/Super_Rotation_System
 */

type OrientationToWallkickMap = {[key in Orientation]?: WallKickList};

const jlstzOrientationToWallKickMap: OrientationToWallkickMap = {
    // 0 -> R
    [Orientation.SPAWN]: [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    // R -> 2
    [Orientation.RIGHT]: [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    // 2 -> L
    [Orientation.TWO]: [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    // L -> 0
    [Orientation.LEFT]: [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
};

const iOrientationToWallKickMap: OrientationToWallkickMap = {
    // 0 -> R
    [Orientation.SPAWN]: [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    // R -> 2
    [Orientation.RIGHT]: [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
    // 2 -> L
    [Orientation.TWO]: [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    // L -> 0
    [Orientation.LEFT]: [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
};

/**
 * Brute force rotation algorithm for bounding boxes.
 * Since they are only 4x4 at most, this method suffices.
 */
const rotateShape = (prev: BrickShape, orientation: Orientation) => {
    const size = shapeSize(prev);
    let cur: BrickShape = copyBrickShape(prev);
    for (let i = 0; i < orientation; i++) {
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                cur[x][size - 1 - y] = prev[y][x];
            }
        }
        prev = copyBrickShape(cur);
    }
    return cur;
}

/**
 * Code for the grid of static bricks.
 */

type EmptyCell = -1;

type Cell = BrickType | EmptyCell;

const emptyCell: Cell = -1;

type Grid = Cell[][];

const isEmptyCell = (grid: Grid, x: number, y: number) =>
    grid[y] === undefined || grid[y][x] === emptyCell;

const collision = (grid: Grid, shape: BrickShape, x0: number, y0: number) => {
    const size = shapeSize(shape);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (shape[y][x] && !isEmptyCell(grid, x0 + x, y0 + y)) {
                return true;
            }
        }
    }
    return false;
};

/**
 * Create a new empty row.
 */
const emptyRow = (width: number) => [...Array(width)].map(() => emptyCell);

/**
 * Create the game grid. It will store all bricks except the currently
 * dropping one. It's a multi-dimensional array where each subarray is
 * a row. This representation makes clearing rows easier.
 */
const emptyCells = (width: number, height: number) =>
    [...Array(height)].map(() => emptyRow(width));

const isCompleteRow = (row: BrickType[]) => row.every(x => x !== emptyCell);

const hasCompletedRow =
    (grid: Grid) => grid.some(isCompleteRow);

const removeCompletedRowsFromGrid = (grid: Grid): Grid => {
    const remaining = [];
    for (const row of grid) {
        if (!isCompleteRow(row)) remaining.push(row);
    }
    const newGrid: Grid = [];
    for (let i = 0; i < GRID_HEIGHT - remaining.length; i++) {
        newGrid.push(emptyRow(GRID_WIDTH));
    }
    for (const row of remaining) {
        newGrid.push(row);
    }
    return newGrid;
};

/**
 * Currently falling brick code.
 */

/**
 * A class holds all state and defines helper methods.
 * I chose this pattern over completely immutable state for brevity.
 */
class FallingBrick {
    x: number = UNSPAWNED_POS;
    y: number = UNSPAWNED_POS;
    orientation: Orientation = Orientation.SPAWN;

    constructor(public readonly type: BrickType) {}

    isUnspawned(): boolean {
        return this.x === UNSPAWNED_POS;
    }

    /**
     * Gets brick shape after applying the rotation.
     */
    shape(): BrickShape {
        const shape = brickTypeToShapeMap[this.type];
        if (this.isUnspawned() || this.type === BrickType.O) return shape;
        return rotateShape(shape, this.orientation);
    }

    spawn() {
        const shape = this.shape();
        const size = shapeSize(shape);
        this.x = Math.floor((GRID_WIDTH - size) / 2);
        this.y = -size;
    }

    private isTouchingFloor() {
        const shape = this.shape();
        const size = shapeSize(shape);
        for (let y = size - 1; y >= 0; y--) {
            if (isEmptyBitGridRow(shape, y)) continue; // Skip empty rows.
            if (this.y + y + 1 === GRID_HEIGHT) return true;
        }
        return false;
    }

    private isOnTopOfBricks(grid: Grid) {
        return collision(grid, this.shape(), this.x, this.y + 1);
    }

    private canFall(grid: Grid) {
        return !this.isTouchingFloor() && !this.isOnTopOfBricks(grid);
    }

    /**
     * Returns true if the brick can no longer fall.
     */
    tickGravity(grid: Grid) {
        if (!this.canFall(grid)) return true;
        this.y++;
        return false;
    }

    gameOver(grid: Grid) {
        return this.isOnTopOfBricks(grid) && this.y < 0;
    }

    rotate(grid: Grid) {
        if (this.isUnspawned()) return;
        if (this.type === BrickType.O) return;

        let nextOrientation = incrementOrientation(this.orientation);
        let nextShape = rotateShape(this.shape(), nextOrientation);

        const orientationToWallkickMap =
            this.type === BrickType.I ?
                iOrientationToWallKickMap : jlstzOrientationToWallKickMap;
        for (const pair of orientationToWallkickMap[this.orientation]) {
            const [dx, dy] = pair;
            if (!collision(grid, nextShape, this.x + dx, this.y + dy)) {
                this.orientation = nextOrientation;
                this.x += dx;
                this.y += dy;
                return;
            }
        }
    }

    private isAgainstWall(left: boolean) {
        const shape = this.shape();
        const size = shapeSize(shape);
        const bound = left ? 0 : GRID_WIDTH - 1;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (shape[y][x] && this.x + x === bound) return true;
            }
        }
        return false;
    }

    private canMove(grid: Grid, left: boolean) {
        const shape = this.shape();
        return (!collision(grid, shape, this.x + (left ? -1 : 1), this.y)
                && !this.isAgainstWall(left));
    }

    private canMoveLeft(grid: Grid) {
        return this.canMove(grid, true);
    }

    private canMoveRight(grid: Grid) {
        return this.canMove(grid, false);
    }

    moveLeft(grid: Grid) {
        if (this.isUnspawned() || !this.canMoveLeft(grid)) return;
        this.x--;
    }

    moveRight(grid: Grid) {
        if (this.isUnspawned() || !this.canMoveRight(grid)) return;
        this.x++;
    }

    fastFall(grid: Grid) {
        if (this.isUnspawned()) return;
        while (this.canFall(grid)) this.y++;
    }

    copy() {
        const copy = new FallingBrick(this.type);
        copy.x = this.x;
        copy.y = this.y;
        copy.orientation = this.orientation;
        return copy;
    }
}

/**
 * Code for game state.
 */

/**
 * Different "modes" the game can be in.
 * Each phase has a different view.
 */
enum GamePhase {
    UNSTARTED = 0,
    IN_PROGRESS = 1,
    OVER = 2,
}

type Queue = BrickType[];

/**
 * Interface for game state.
 */
interface State {
    phase: GamePhase;
    bricks: Grid;
    score: number;
    fallingBrick: FallingBrick;
    queue: Queue;
    completedRowAnimationFrame: number | null;
}

/**
 * Initialize state for the start of a game with a random
 * brick type.
 */
const initialState = (): State => ({
    phase: GamePhase.UNSTARTED,
    bricks: emptyCells(GRID_WIDTH, GRID_HEIGHT),
    score: 0,
    fallingBrick: new FallingBrick(randomBrickType()),
    queue: [...Array(QUEUE_SIZE)].map(() => randomBrickType()),
    completedRowAnimationFrame: null,
});

const writeFallingBrickToGrid = (state: State) => {
    const shape = state.fallingBrick.shape();
    const size = shapeSize(shape);
    for (let y = 0; y < size; y++) {
        if (shape[y].every(x => !x)) continue;
        for (let x = 0; x < size; x++) {
            if (!shape[y][x]) continue;
            state.bricks[state.fallingBrick.y + y][state.fallingBrick.x + x] =
                state.fallingBrick.type;
        }
    }
}

const gameOver = (state: State): State => ({...state, phase: GamePhase.OVER});

const dequeueNextBrick = (state: State): State => ({
    ...state,
    queue: [...state.queue.slice(1, QUEUE_SIZE), randomBrickType()],
    fallingBrick: new FallingBrick(state.queue[0]),
});

const isRowAnimating =
    (state: State) => state.completedRowAnimationFrame !== null;

const nextFrame = (x: number) => x === ROW_ANIMATION_FRAMES ? null : x + 1;

const tickCompletedRowAnimation = (state: State) => ({
    ...state,
    completedRowAnimationFrame:
        isRowAnimating(state) ?
            nextFrame(state.completedRowAnimationFrame) : 0,
});

const removeCompletedRows = (state: State) => ({
    ...state,
    bricks: removeCompletedRowsFromGrid(state.bricks),
});

const awardPoints = (state: State) => {
    let points = 0;
    for (const row of state.bricks) {
        if (isCompleteRow(row)) points += POINTS_PER_ROW;
    }
    return {...state, score: state.score + points};
};

/**
 * Update state after a clock tick.
 */
const tickClock = (state: State): State => {
    if (state.phase !== GamePhase.IN_PROGRESS) return state;
    if (isRowAnimating(state)) {
        state = tickCompletedRowAnimation(state);
        if (isRowAnimating(state)) return state;
        return removeCompletedRows(state);
    }
    if (state.fallingBrick.isUnspawned()) state.fallingBrick.spawn();
    if (state.fallingBrick.tickGravity(state.bricks)) {
        if (state.fallingBrick.gameOver(state.bricks)) {
            return gameOver(state);
        }
        writeFallingBrickToGrid(state);
        state = dequeueNextBrick(state);
        if (!hasCompletedRow(state.bricks)) return state;
        return awardPoints(tickCompletedRowAnimation(state));
    }
    return state;
};

/**
 * Possible actions on the state.
 */
enum Action {
    TICK_CLOCK = 0,
    START_GAME = 1,
    DOWN = 2,
    LEFT = 3,
    RIGHT = 4,
    UP = 5,
}

/**
 * Define player controller.
 */

const getElem = (id: string) => document.getElementById(id);

const fromClick = (id: string) => fromEvent(getElem(id), 'click');

const clickToStart = (id: string): Observable<Action.START_GAME> =>
    fromClick(id).pipe(mapTo(Action.START_GAME));

const startGame$ = clickToStart(START_GAME_ID);
const restartGame$ = clickToStart(RESTART_GAME_ID);

enum KeyCode {
    DOWN = 'ArrowDown',
    LEFT = 'ArrowLeft',
    RIGHT = 'ArrowRight',
    UP = 'ArrowUp',
}

type KeyAction = Action.DOWN | Action.LEFT | Action.RIGHT | Action.UP;

const keyCodeToActionMap: {[key in KeyCode]?: KeyAction} = {
    [KeyCode.DOWN]: Action.DOWN,
    [KeyCode.LEFT]: Action.LEFT,
    [KeyCode.RIGHT]: Action.RIGHT,
    [KeyCode.UP]: Action.UP,
};

const keycodeToAction = (kc: KeyCode): KeyAction =>
    (keyCodeToActionMap[kc] || null);

const keyboard$ = fromEvent(document, 'keydown').pipe(
    map((ev: KeyboardEvent) => keycodeToAction(ev.code as KeyCode)));

const controller$: Observable<Action> = merge(startGame$, restartGame$, keyboard$);

/**
 * Rendering.
 */

const changeDisplay = (id: string, display: string) => {
    const el = getElem(id);
    if (el.style.display !== display) el.style.display = display;
};

const hideElem = (id: string) => changeDisplay(id, 'none');

const showElem = (id: string) => changeDisplay(id, 'flex');

const setInnerText = (id: string, text: string) => {
    const el = getElem(id);
    if (el.textContent !== text) el.textContent = text;
}

const renderPhase = (phase: GamePhase) => {
    switch (phase) {
        case GamePhase.UNSTARTED:
            showElem(UNSTARTED_ID);
            hideElem(IN_PROGRESS_ID);
            hideElem(GAME_OVER_ID);
            break;
        case GamePhase.IN_PROGRESS:
            hideElem(UNSTARTED_ID);
            showElem(IN_PROGRESS_ID);
            hideElem(GAME_OVER_ID);
            break;
        case GamePhase.OVER:
            hideElem(UNSTARTED_ID);
            hideElem(IN_PROGRESS_ID);
            showElem(GAME_OVER_ID);
            break;
        default:
            throw new Error(`Unexpected phase: ${phase}`);
    }
};

const scoreString = (s: State) => `Score: ${s.score}`;

const cellId = (x: number, y: number) => `cell-${x}-${y}`;

const brickTypeToClassMap: {[key in Cell]?: string} = {
    [BrickType.I]: 'cell-i',
    [BrickType.L]: 'cell-l',
    [BrickType.J]: 'cell-j',
    [BrickType.O]: 'cell-o',
    [BrickType.S]: 'cell-s',
    [BrickType.Z]: 'cell-z',
    [BrickType.T]: 'cell-t',
};

const hasClasses = (el: HTMLElement, classes: string[]) =>
    (classes.length === el.classList.length
        && classes.every(cls => el.classList.contains(cls)));

const setClasslist = (el: HTMLElement, ...classes: string[]) => {
    if (hasClasses(el, classes)) return;
    el.className = '';
    el.classList.add(...classes.filter(Boolean));
};

const px = (x: number) => `${x * CELL_SIZE_PX}px`;

const hasPos = (el: HTMLElement, x: number, y: number) =>
    (el.style.left === px(x) && el.style.top === px(y));

const setPos = (el: HTMLElement, x: number, y: number) => {
    if (hasPos(el, x, y)) return;
    el.style.left = px(x);
    el.style.top = px(y);
}

const createGridIfDoesntExist = () => {
    const board = getElem(BOARD_ID);
    if (board.children.length > BOARD_HTML_CHILDREN) return;
    for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
            const el = document.createElement('div');
            el.id = cellId(x, y);
            setClasslist(el, CELL_CLASS);
            setPos(el, x, y);
            board.appendChild(el);
        }
    }
};

const completedRowAnimationClass = (state: State, y: number) => {
    if (!isRowAnimating(state)|| !isCompleteRow(state.bricks[y])) return '';
    const x = Math.floor(
        state.completedRowAnimationFrame / ROW_ANIMATION_INTERVAL);
    if (x % 2 == 0) {
        return ROW_ANIMATION_CELL_CLASS;
    }
}

const renderStationaryBricks = (state: State) => {
    createGridIfDoesntExist();
    for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
            setClasslist(
                getElem(cellId(x, y)), CELL_CLASS,
                brickTypeToClassMap[state.bricks[y][x]] || '',
                completedRowAnimationClass(state, y));
        }
    }
};

const hiddenElemClass = (y: number) => (y < 0 ? HIDDEN_ELEM_CLASS : '');

const renderBrickFromShape =
    (container: HTMLElement, shape: BrickShape, type: BrickType, x0: number,
     y0: number) => {
        const size = shapeSize(shape);
        for (let x = 0; x < size; x++) {
            for (let y = 0; y < size; y++) {
                if (!shape[y][x]) continue;
                const el = document.createElement('div');
                setClasslist(
                    el, CELL_CLASS, brickTypeToClassMap[type],
                    hiddenElemClass(y0 + y));
                setPos(el, x0 + x, y0 + y);
                container.appendChild(el);
            }
        }
    };

const removeChildren = (el: HTMLElement) => {
    while (el.lastChild) el.removeChild(el.lastChild);
    return el;
}

const renderQueueBrick = (container: HTMLElement, type: BrickType) => {
    renderBrickFromShape(
        removeChildren(container), brickTypeToShapeMap[type], type, 0, 0);
};

const renderQueue = (queue: Queue) => {
    for (let i = 0; i < QUEUE_SIZE; i++) {
        renderQueueBrick(getElem(`queue-${i}`), queue[i]);
    }
};

const renderFallingBrick = (fb: FallingBrick) => {
    const container = removeChildren(getElem(FALLING_BRICK_ID));
    if (fb.isUnspawned()) return;
    renderBrickFromShape(container, fb.shape(), fb.type, fb.x, fb.y);
};

const renderProjection = (fb: FallingBrick, grid: Grid) => {
    const proj = fb.copy();
    proj.fastFall(grid);
    if (proj.y === fb.y) return;
    renderBrickFromShape(
        removeChildren(getElem(PROJECTION_ID)),
        proj.shape(), proj.type, proj.x, proj.y);
};

const renderGameFromState = (state: State) => {
    setInnerText(SIDEBAR_SCORE_ID, scoreString(state));
    renderStationaryBricks(state);
    renderQueue(state.queue);
    renderFallingBrick(state.fallingBrick);
    renderProjection(state.fallingBrick, state.bricks);
};

const render = (state: State) => {
    hideElem(LOADING_ID);
    renderPhase(state.phase);
    switch (state.phase) {
        case GamePhase.IN_PROGRESS:
            renderGameFromState(state);
            return;
        case GamePhase.OVER:
            setInnerText(GAME_OVER_SCORE_ID, scoreString(state));
        default:
            return;
    }
};

/**
 * Clock ticking is used to update the bricks' vertical position.
 */

const clock$ = timer(0, 1000 / FPS).pipe(mapTo(Action.TICK_CLOCK));

/**
 * Game loop uses Redux-style reducer.
 */

const handleActions = (state: State, action: Action): State => {
    switch (action) {
        case Action.TICK_CLOCK:
            return tickClock(state);
        case Action.START_GAME:
            return {...initialState(), phase: GamePhase.IN_PROGRESS};
        case Action.LEFT:
            state.fallingBrick.moveLeft(state.bricks);
            return state;
        case Action.RIGHT:
            state.fallingBrick.moveRight(state.bricks);
            return state;
        case Action.UP:
            state.fallingBrick.rotate(state.bricks);
            return state;
        case Action.DOWN:
            state.fallingBrick.fastFall(state.bricks);
        default:
            return state;
    }
}

const game$ = merge(clock$, controller$).pipe(
    scan(handleActions, initialState()),
    tap(render));

game$.subscribe();
