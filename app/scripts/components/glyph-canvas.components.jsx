/* global webkitRequestAnimationFrame, webkitCancelAnimationFrame */
import _get from 'lodash/get';
import _slice from 'lodash/slice';
import React from 'react';
import pleaseWait from 'please-wait';
import Lifespan from 'lifespan';

import Toile, {mState, toileType, appState, transformCoords, inverseProjectionMatrix, canvasMode, specialKey} from '../toile/toile';

import {changeTransformOrigin, glyphBoundingBox} from '../prototypo.js/utils/generic';
import {matrixMul, dot2D, mulScalar2D, subtract2D, normalize2D, add2D, distance2D} from '../prototypo.js/utils/linear';

import LocalClient from '../stores/local-client.stores';

import FontUpdater from './font-updater.components';

const raf = requestAnimationFrame || webkitRequestAnimationFrame;
const rafCancel = cancelAnimationFrame || webkitCancelAnimationFrame;
let rafId;

const MINIMUM_DRAG_THRESHOLD = 6;
const MINIMUM_DRAG_DIRECTIONAL_THRESHOLD = 10;

const agnosticCtrl = navigator.platform.indexOf('Mac') !== -1
	? specialKey.META
	: specialKey.CTRL;

const directionalMod = {
	X: 0b1,
	Y: 0b10,
};

const onCurveModMode = {
	WIDTH_MOD: 0b1,
	ANGLE_MOD: 0b10,
};

function changeGlyphManually(changes, glyph, client) {
	const glyphName = glyph.base || glyph.name;

	client.dispatchAction('/change-glyph-node-manually', {
		changes,
		glyphName,
	});
}

function calculateHandleCoordinateModification(
	parentRef,
	ownParent,
	newPos,
	handlePos,
	tension,
	isIn,
	refLength,
) {
	const handleBase = isIn
		? {x: ownParent.handleOut.xBase, y: ownParent.handleOut.yBase}
		: {x: ownParent.handleIn.xBase, y: ownParent.handleIn.yBase};
	const relativeNewPos = subtract2D(newPos, parentRef);
	const relativeBasePos = subtract2D(handlePos, parentRef);
	const relativeOpPos = subtract2D(handleBase, ownParent);
	const modAngle = Math.atan2(relativeOpPos.y, relativeOpPos.x)
		+ Math.atan2(relativeNewPos.y, relativeNewPos.x)
		- Math.atan2(relativeBasePos.y, relativeBasePos.x);

	const length = distance2D(handleBase, ownParent);
	const actualLength = length === 0 ? refLength : length * tension;

	const newOpPos = add2D(ownParent, {
		x: Math.cos(modAngle) * actualLength,
		y: Math.sin(modAngle) * actualLength,
	});
	const opVector = subtract2D(newOpPos, handleBase);

	return opVector;
}

function handleModification(client, glyph, draggedItem, newPos, unsmoothMod, unparallelMod) {
	const {
		parentId, transforms,
	} = draggedItem.data;
	const handle = _get(glyph, draggedItem.id);
	const handlePos = {
		x: handle.xBase,
		y: handle.yBase,
	};
	const parent = _get(glyph, parentId);
	let xTransform = 1;
	let yTransform = 1;

	for (let i = 0; i < transforms.length; i++) {
		const transform = transforms[i];

		if (transform) {
			xTransform /= transform.name.indexOf('scaleX') === -1 ? 1 : transform.param;
			yTransform /= transform.name.indexOf('scaleY') === -1 ? 1 : transform.param;
		}
	}
	const newVectorPreTransform = subtract2D(newPos, handlePos);
	const newVector = {
		x: newVectorPreTransform.x * xTransform,
		y: newVectorPreTransform.y * yTransform,
	};
	const refLength = distance2D(newPos, parent);
	const tension = refLength / distance2D(handlePos, parent);
	const isIn = toileType.NODE_IN === draggedItem.type
		|| toileType.CONTOUR_NODE_IN === draggedItem.type;

	const direction = isIn ? 'in' : 'out';
	const oppositeDirection = isIn ? 'out' : 'in';

	const changes = {
		[`${draggedItem.data.parentId}.${direction}.x`]: newVector.x,
		[`${draggedItem.data.parentId}.${direction}.y`]: newVector.y,
	};

	if (!unsmoothMod && (parent.baseTypeIn === 'smooth' || parent.baseTypeOut === 'smooth')) {
		const opVector = calculateHandleCoordinateModification(
			parent,
			parent,
			newPos,
			handlePos,
			tension,
			isIn,
			refLength,
		);

		changes[`${draggedItem.data.parentId}.${oppositeDirection}.x`]
			= opVector.x * xTransform;
		changes[`${draggedItem.data.parentId}.${oppositeDirection}.y`]
			= opVector.y * yTransform;

		if (!unparallelMod) {
			const parallelParent = _get(glyph, draggedItem.data.parallelId);
			const parallelVector = calculateHandleCoordinateModification(
				parent,
				parallelParent,
				newPos,
				handlePos,
				tension,
				!isIn,
				refLength,
			);

			changes[`${draggedItem.data.parallelId}.${direction}.x`]
				= parallelVector.x * xTransform;
			changes[`${draggedItem.data.parallelId}.${direction}.y`]
				= parallelVector.y * xTransform;
		}
	}

	if (!unparallelMod) {
		const parallelParent = _get(glyph, draggedItem.data.parallelId);
		const parallelOpVector = calculateHandleCoordinateModification(
			parent,
			parallelParent,
			newPos,
			handlePos,
			tension,
			isIn,
			refLength,
		);

		changes[`${draggedItem.data.parallelId}.${oppositeDirection}.x`]
			= parallelOpVector.x * xTransform;
		changes[`${draggedItem.data.parallelId}.${oppositeDirection}.y`]
			= parallelOpVector.y * yTransform;
	}

	changeGlyphManually(changes, glyph, client);
}

function onCurveModification(
	client,
	glyph,
	draggedItem,
	newPos,
	appStateValue,
	modToApply,
) {
	const {
		baseWidth,
		oppositeId,
		baseAngle,
		skeleton,
		angleOffset,
		transforms,
	} = draggedItem.data;
	const opposite = _get(glyph, oppositeId);
	const newPosition = newPos;
	const widthVector = subtract2D(opposite, newPosition);

	let xTransform = 1;
	let yTransform = 1;

	for (let i = 0; i < transforms.length; i++) {
		const transform = transforms[i];

		if (transform) {
			xTransform /= transform.name.indexOf('scaleX') === -1 ? 1 : transform.param;
			yTransform /= transform.name.indexOf('scaleY') === -1 ? 1 : transform.param;
		}
	}

	const transformedWidthVector = {
		x: xTransform * widthVector.x,
		y: yTransform * widthVector.y,
	};
	const newWidth = distance2D({x: 0, y: 0}, transformedWidthVector);
	// width factor
	const factor = newWidth / baseWidth;
	// angle difference
	const newVec = subtract2D(newPosition, skeleton);
	const transformedVec = {
		x: xTransform * newVec.x,
		y: yTransform * newVec.y,
	};

	const angleDiff = Math.atan2(transformedVec.y, transformedVec.x) - baseAngle;

	const changes = {};

	if (modToApply & onCurveModMode.WIDTH_MOD) { // eslint-disable-line no-bitwise
		changes[`${draggedItem.data.modifAddress}.width`] = factor;
	}

	if (modToApply & onCurveModMode.ANGLE_MOD) { // eslint-disable-line no-bitwise
		changes[`${draggedItem.data.modifAddress}.angle`] = angleDiff + angleOffset;
	}

	changeGlyphManually(changes, glyph, client);
}

function skeletonPosModification(client, glyph, draggedItem, newPos) {
	const {base, transforms} = draggedItem.data;

	const mouseVec = subtract2D(newPos, base);
	let xTransform = 1;
	let yTransform = 1;

	for (let i = 0; i < transforms.length; i++) {
		const transform = transforms[i];

		if (transform) {
			xTransform /= transform.name.indexOf('scaleX') === -1 ? 1 : transform.param;
			yTransform /= transform.name.indexOf('scaleY') === -1 ? 1 : transform.param;
		}
	}

	const changes = {
		[`${draggedItem.data.modifAddress}x`]: mouseVec.x * xTransform,
		[`${draggedItem.data.modifAddress}y`]: mouseVec.y * yTransform,
	};

	changeGlyphManually(changes, glyph, client);
}

function skeletonDistrModification(client, glyph, draggedItem, newPos) {
	const {
		base,
		expandedTo,
		width,
		baseDistr,
	} = draggedItem.data;
	const skelVec = normalize2D(subtract2D(expandedTo[1], expandedTo[0]));
	const distProjOntoSkel = Math.min(Math.max(dot2D(
		subtract2D(newPos, expandedTo[0]),
		skelVec,
	), 0), width);
	const mouseVec = subtract2D(
		add2D(mulScalar2D(distProjOntoSkel, skelVec), expandedTo[0]),
		base,
	);

	const changes = {
		[`${draggedItem.data.modifAddress}expand.distr`]: (distProjOntoSkel / width) - baseDistr,
		[`${draggedItem.data.modifAddress}x`]: mouseVec.x,
		[`${draggedItem.data.modifAddress}y`]: mouseVec.y,
	};

	changeGlyphManually(changes, glyph, client);
}

function changeSpacing(client, glyph, draggedItem, newPos) {
	if (draggedItem.id === 'spacingLeft') {
		client.dispatchAction('/change-letter-spacing', {
			value: glyph.spacingLeft - glyph.baseSpacingLeft - newPos.x,
			side: 'left',
			letter: String.fromCharCode(glyph.unicode),
		});
	}
	else if (draggedItem.id === 'spacingRight') {
		client.dispatchAction('/change-letter-spacing', {
			value: newPos.x - glyph.advanceWidth + glyph.spacingRight - glyph.baseSpacingRight,
			side: 'right',
			letter: String.fromCharCode(glyph.unicode),
		});
	}
}

export default class GlyphCanvas extends React.PureComponent {
	constructor(props) {
		super(props);
		this.state = {
			values: {},
		};

		this.changeParam = this.changeParam.bind(this);
		this.download = this.download.bind(this);
	}

	componentWillMount() {
		pleaseWait.instance.finish();
		this.client = LocalClient.instance();
		this.lifespan = new Lifespan();

		this.client.getStore('/fontInstanceStore', this.lifespan)
			.onUpdate(() => {
				if (
					this.state.glyph
					&& window.glyph
					&& this.state.glyph.name !== window.glyph.name
				) {
					this.resetAppMode = true;
				}
				this.setState({
					glyph: window.glyph,
				});
			})
			.onDelete(() => {
				this.setState(undefined);
			});

		this.client.getStore('/prototypoStore', this.lifespan)
			.onUpdate((head) => {
				this.setState({
					canvasMode: head.toJS().d.canvasMode,
					uiOutline: head.toJS().d.uiOutline,
				});
			})
			.onDelete(() => {
				this.setState(undefined);
			});

		this.client.getStore('/undoableStore', this.lifespan)
			.onUpdate((head) => {
				this.setState({
					values: head.toJS().d.controlsValues,
				});
			})
			.onDelete(() => {
				this.setState(undefined);
			});
	}

	componentDidMount() {
		this.toile = new Toile(this.canvas);
		this.setCamera({x: 0, y: 0}, 1, this.canvas.clientHeight, this.canvas.clientWidth);

		if (module.hot) {
			module.hot.accept('../toile/toile', () => {
				const ToileConstructor = require('../toile/toile').default; // eslint-disable-line global-require
				const [z,,,, tx, ty] = this.toile.viewMatrix;
				const newTs = {
					x: tx,
					y: ty,
				};

				this.toile = new ToileConstructor(this.canvas);

				this.setCameraCenter(newTs, z, -this.canvas.clientHeight, this.canvas.clientWidth);
			});
		}

		const frameCounters = {
			componentMenu: 0,
		};
		let componentMenuPos = {};
		let componentHovered = {};
		let selectedItems = [];
		let contourSelected;
		let contourSelectedIndex = 0;
		// let dragging = true;
		let mouse = this.toile.getMouseState();
		let appStateValue = appState.DEFAULT;
		let appMode;
		let oldAppMode;
		let oldAppState;
		let oldViewMatrix;
		let mouseDoubleClick;
		let pause = false;
		let firstDraw = true;
		let mouseStart;
		let draggingNotStarted = false;
		let directionalNotStarted = false;
		let directionalValue;

		// Box select variables
		let mouseBoxStart;

		const rafFunc = () => {
			if (this.toile.keyboardDownRisingEdge.keyCode === 80) {
				pause = !pause;
			}

			/* eslint-disable no-bitwise, max-depth */
			const hotItems = this.toile.getHotInteractiveItem();

			let boxedItems = [];
			let mouseMovement;

			if (mouseBoxStart) {
				boxedItems = this.toile.getBoxHotInteractiveItem(mouseBoxStart);
			}
			const width = this.canvas.clientWidth;
			const height = this.canvas.clientHeight;

			this.canvas.height = height;
			this.canvas.width = width;
			const oldMouse = mouse;
			let mouseClickRelease = false;

			mouse = this.toile.getMouseState();

			switch (this.state.canvasMode) {
			case 'components':
				appMode = canvasMode.COMPONENTS;
				break;
			case 'select-points':
				appMode = canvasMode.SELECT_POINTS;
				break;
			case 'move':
			default:
				appMode = canvasMode.MOVE;
				break;
			}

			if (mouse.state === mState.UP
				&& oldMouse.state === mState.DOWN) {
				mouseClickRelease = true;
			}

			const {glyph} = this.state;


			if (glyph) {
				const nodes = hotItems.filter(item => item.type <= toileType.CONTOUR_NODE_OUT);
				const spacingHandle = hotItems.filter(item => item.type === toileType.SPACING_HANDLE);
				const contours = hotItems.filter(item =>
					item.type === toileType.GLYPH_CONTOUR
					|| item.type === toileType.GLYPH_COMPONENT_CONTOUR);
				let componentMenu = hotItems.filter(item => item.type === toileType.COMPONENT_MENU_ITEM_CENTER);
				let componentChoice = hotItems.filter(item => item.type === toileType.COMPONENT_MENU_ITEM);
				const componentChoiceClass = hotItems.filter(item => item.type === toileType.COMPONENT_MENU_ITEM_CLASS);
				let components = hotItems.filter(item => item.type === toileType.COMPONENT_CHOICE
						|| item.type === toileType.COMPONENT_NONE_CHOICE);

				const [mousePosInWorld] = transformCoords(
					[mouse.pos],
					inverseProjectionMatrix(this.toile.viewMatrix),
					this.toile.height / this.toile.viewMatrix[0],
				);

				// This is used to detect a glyph change event that
				// makes it necessary to stop all active mode
				if (this.resetAppMode) {
					appStateValue = appState.DEFAULT;
					selectedItems = [];
					this.resetAppMode = false;
				}

				const outside = this.toile.glyphOutsideView(glyph);

				if (outside && !this.props.glyphOutsideView) {
					this.client.dispatchAction('/store-value', {glyphOutsideView: true});
				}
				else if (!outside && this.props.glyphOutsideView) {
					this.client.dispatchAction('/store-value', {glyphOutsideView: false});
				}

				// Detection of double click in any mode
				if (mouse.edge === mState.DOWN) {
					if (mouseDoubleClick) {
						this.resetView(glyph, height, width);
					}
					else {
						mouseDoubleClick = true;
						setTimeout(() => {
							mouseDoubleClick = false;
						}, 400);
					}
				}

				if (this.toile.keyboardUp.keyCode) {
					const {keyCode} = this.toile.keyboardUp;

					// Detect space keyboard up event to reset mode to the previous mode
					if (keyCode === 32) {
						appMode = oldAppMode;
						this.client.dispatchAction('/store-value', {canvasMode: oldAppMode});
						if (appMode === 'select-points') {
							appStateValue = oldAppState;
						}

						oldAppMode = undefined;
						oldAppState = undefined;
						this.toile.clearKeyboardInput();
					}
				}

				if (this.toile.keyboardDownRisingEdge.keyCode) {
					const {keyCode} = this.toile.keyboardDownRisingEdge;

					// On space edge down keyboard event switch to move mode
					// whatever the previous mode is
					if (keyCode === 32) {
						oldAppMode = this.state.canvasMode;
						oldAppState = appStateValue;
						appMode = canvasMode.MOVE;
						this.client.dispatchAction('/store-value', {canvasMode: 'move'});
					}
				}

				// =========================================================
				// =========================================================
				// This is the state machine state changing part
				// There is 3 first level state
				if (appMode === canvasMode.MOVE) {
					// when in move mode the only action possible is to move
					// this happen if mouse is in down state
					if (mouse.state === mState.DOWN) {
						appStateValue = appState.MOVING;
					}
					else {
						appStateValue = appState.DEFAULT;
					}
				}
				if (appMode === canvasMode.COMPONENTS) {
					// On mouse release with look for any hot menu item
					// and change component accordingly
					if (mouseClickRelease) {
						if (componentChoice.length > 0) {
							const [choice] = componentChoice;

							this.client.dispatchAction('/change-component', {
								glyph,
								id: choice.data.componentId,
								name: choice.data.baseId,
							});

							componentChoice = [];
							componentMenu = [];
							components = [];
						}
						if (componentChoiceClass.length > 0) {
							const [choice] = componentChoiceClass;

							this.client.dispatchAction('/change-component-class', {
								componentClass: choice.data.componentClass,
								name: choice.data.baseId,
							});

							componentChoice = [];
							componentMenu = [];
							components = [];
						}
					}

					// If a component geometry is hovered
					// We set the correct mode to draw it
					if ((appStateValue === appState.DEFAULT || appStateValue === appState.COMPONENT_HOVERED) && components.length > 0) {
						appStateValue = appState.COMPONENT_HOVERED;
						componentHovered = components[0];
					}
					else if (componentMenu.length > 0) {
						appStateValue = appState.COMPONENT_MENU_HOVERED;
					}
					else {
						componentHovered = {};
						appStateValue = appState.DEFAULT;
					}
				}
				if (appMode === canvasMode.SELECT_POINTS) {
					// Manual edition mode
					if ((appStateValue === appState.DEFAULT) && mouse.edge === mState.DOWN) {
						if (spacingHandle.length > 0) {
							appStateValue = appState.DRAGGING_SPACING;
							selectedItems = [spacingHandle[0]];
							this.storeSelectedItems(selectedItems);
						}
						else {
							appStateValue = appState.BOX_SELECTING;
							mouseBoxStart = mouse.pos;
						}
					}
					else if ((appStateValue & appState.BOX_SELECTING) && mouseClickRelease) {
						if (boxedItems.length > 0) {
							selectedItems = boxedItems;
							appStateValue = appState.POINTS_SELECTED;
							mouseBoxStart = undefined;
						}
						else if (contours.length > 0) {
							contourSelected = contours[contourSelectedIndex % contours.length];
							contourSelectedIndex++;
							appStateValue = appState.CONTOUR_SELECTED;
						}
						else {
							appStateValue = appState.DEFAULT;
							mouseBoxStart = undefined;
						}
						this.storeSelectedItems(selectedItems);
					}
					else if ((appStateValue & appState.CONTOUR_SELECTED) && mouse.edge === mState.DOWN) {
						if (nodes.length > 0) {
							selectedItems = [nodes[0]];
							appStateValue = appState.DRAGGING_CONTOUR_POINT;
							mouseStart = nodes[0].data.center;
							draggingNotStarted = true;
							directionalNotStarted = true;
						}
						else if (contours.length > 0) {
							if (contours.find(c => c.id === contourSelected.id)) {
								appStateValue = appState.DRAGGING_CONTOUR;
							}
							else {
								appStateValue = appState.BOX_SELECTING;
								mouseBoxStart = mouse.pos;
								contourSelected = undefined;
								contourSelectedIndex = 0;
							}
						}
						else if (spacingHandle.length > 0) {
							appStateValue = appState.DRAGGING_SPACING;
							selectedItems = [spacingHandle[0]];
						}
						else {
							appStateValue = appState.BOX_SELECTING;
							mouseBoxStart = mouse.pos;
							contourSelected = undefined;
							contourSelectedIndex = 0;
						}
						this.storeSelectedItems(selectedItems);
					}
					else if ((appStateValue & (appState.DRAGGING_CONTOUR_POINT | appState.DRAGGING_SPACING)) && mouseClickRelease) {
						if (selectedItems[0].type === toileType.NODE_SKELETON) {
							appStateValue = appState.SKELETON_POINT_SELECTED;
						}
						else if (selectedItems[0].type === toileType.SPACING_HANDLE) {
							appStateValue = appState.SPACING_SELECTED;
						}
						else {
							appStateValue = appState.CONTOUR_POINT_SELECTED;
						}
						draggingNotStarted = false;
						directionalNotStarted = false;
						this.client.dispatchAction('/change-glyph-node-manually', {
							label: 'manual edition',
							force: true,
							changes: {},
						});
					}
					else if ((appStateValue & appState.DRAGGING_CONTOUR) && mouseClickRelease) {
						appStateValue = appState.CONTOUR_SELECTED;
					}
					else if (
						(appStateValue
							& (
								appState.CONTOUR_POINT_SELECTED
								| appState.SPACING_SELECTED
								| appState.SKELETON_POINT_SELECTED
							)
						)
						&& mouse.edge === mState.DOWN
					) {
						if (nodes.length > 0) {
							selectedItems = [nodes[0]];
							appStateValue = appState.DRAGGING_CONTOUR_POINT;
							mouseStart = nodes[0].data.center;
							draggingNotStarted = true;
							directionalNotStarted = true;
						}
						else if (contours.length > 0 && contourSelected) {
							if (contours.find(c => c.id === contourSelected.id)) {
								appStateValue = appState.DRAGGING_CONTOUR;
							}
							else {
								appStateValue = appState.BOX_SELECTING;
								mouseBoxStart = mouse.pos;
							}
							selectedItems = [];
						}
						else if (spacingHandle.length > 0) {
							appStateValue = appState.DRAGGING_SPACING;
							selectedItems = [spacingHandle[0]];
						}
						else {
							selectedItems = [];
							appStateValue = appState.BOX_SELECTING;
							mouseBoxStart = mouse.pos;
						}
						this.storeSelectedItems(selectedItems);
					}
					else if ((appStateValue & appState.POINTS_SELECTED) && mouse.edge === mState.DOWN) {
						// TODO: shift behavior
						if (nodes.length > 0) {
							let validPoint = false;

							nodes.forEach((node) => {
								validPoint = selectedItems.find(s => s.id === node.id);
							});

							if (!validPoint) {
								selectedItems = [];
								appStateValue = appState.BOX_SELECTING;
								mouseBoxStart = mouse.pos;
							}
						}
						else {
							selectedItems = [];
							appStateValue = appState.BOX_SELECTING;
							mouseBoxStart = mouse.pos;
						}
						this.storeSelectedItems(selectedItems);
					}
					else if ((appStateValue & appState.DRAGGING_POINTS) && mouseClickRelease) {
						appStateValue = appState.POINTS_SELECTED;
						this.client.dispatchAction('/change-glyph-node-manually', {
							label: 'manual edition',
							force: true,
							changes: {},
						});
					}
				}
				// End of StateMachine
				// =========================================================
				// =========================================================


				if (mouse.wheel) {
					appStateValue |= appState.ZOOMING;
				}
				else {
					appStateValue &= ~appState.ZOOMING;
				}

				const enteringPreview = this.toile.keyboardDownRisingEdge.keyCode === 90;
				const previewMode = this.toile.keyboardDown.keycode === 90;
				const exitingPreview = this.toile.keyboardUpRisingEdge.keyCode === 90;

				if (enteringPreview) {
					oldViewMatrix = this.toile.viewMatrix;
					this.resetView(glyph, height, width);
				}

				if (exitingPreview) {
					const [z,,,, tx, ty] = oldViewMatrix;

					this.setCamera({x: tx, y: ty}, z, -height, width);
				}

				// Drawing basic stuff (glyph, frame, and contours)
				this.toile.clearCanvas(width, height);
				this.toile.drawTypographicFrame(
					glyph,
					this.state.values,
				);
				if (firstDraw) {
					firstDraw = false;
					this.resetView(glyph, height, width);
				}
				this.toile.drawGlyph(glyph, hotItems, this.state.uiOutline);

				if (previewMode) {
					this.cleanUpFrame();
					rafId = raf(rafFunc);
					return;
				}

				this.toile.drawSelectableContour(
					glyph,
					appMode === canvasMode.SELECT_POINTS ? hotItems : [],
				);

				//= ========================================================
				//= ========================================================
				// handle hotness of elements in component mode
				// draw component that are hovered or not
				if (appMode === canvasMode.COMPONENTS) {
					this.toile.drawComponents(glyph.components, [...hotItems, componentHovered]);

					if (appStateValue === appState.COMPONENT_HOVERED) {
						const [component] = components;

						if (componentMenuPos.id !== component.data.id) {
							frameCounters.componentMenu = 0;
						}

						componentMenuPos = this.toile.drawComponentMenu(
							component.data,
							frameCounters.componentMenu,
							hotItems,
							width,
							componentMenuPos,
						);

						frameCounters.componentMenu += 1;
					}
					else if (appStateValue === appState.COMPONENT_MENU_HOVERED) {
						const [component] = componentMenu;

						componentMenuPos = this.toile.drawComponentMenu(
							component.data.component,
							frameCounters.componentMenu,
							hotItems,
							width,
							componentMenuPos,
						);
						frameCounters.componentMenu += 1;
					}
					else {
						componentMenuPos = {};
						frameCounters.componentMenu = 0;
					}
				}
				// =========================================================
				// =========================================================

				if (appMode === canvasMode.SELECT_POINTS && !(appStateValue & (appState.DRAGGING_POINTS | appState.DRAGGING_CONTOUR_POINT))) {
					if (spacingHandle.length > 0) {
						this.canvas.style.cursor = 'ew-resize';
					}
					else {
						this.canvas.style.cursor = 'default';
					}
				}
				else {
					this.canvas.style.cursor = 'default';
				}

				// =========================================================
				// =========================================================
				// draw stuff when in select-points mode
				if (
					appStateValue & (
						appState.CONTOUR_SELECTED
						| appState.DRAGGING_CONTOUR_POINT
						| appState.CONTOUR_POINT_SELECTED
						| appState.DRAGGING_CONTOUR
						| appState.SKELETON_POINT_SELECTED
					)
				) {
					if (draggingNotStarted) {
						const displacement = distance2D(mouseStart, mousePosInWorld) * this.toile.viewMatrix[0];

						if (displacement > MINIMUM_DRAG_THRESHOLD) {
							draggingNotStarted = false;
						}
					}
					else if (contourSelected.data.componentIdx === undefined) {
						this.toile.drawSelectedContour(_slice(
							glyph.otContours,
							contourSelected.data.indexes[0],
							contourSelected.data.indexes[1],
						));
					}
					else {
						this.toile.drawSelectedContour(_slice(
							glyph.components[contourSelected.data.componentIdx].otContours,
							contourSelected.data.indexes[0],
							contourSelected.data.indexes[1],
						));
					}

					if (directionalNotStarted) {
						const displacement = distance2D(mouseStart, mousePosInWorld) * this.toile.viewMatrix[0];
						const deltaVec = subtract2D(mouseStart, mousePosInWorld);
						const isXBigger = Math.abs(deltaVec.x) > Math.abs(deltaVec.y);

						directionalValue = isXBigger ? directionalMod.X : directionalMod.Y;

						if (displacement > MINIMUM_DRAG_DIRECTIONAL_THRESHOLD) {
							directionalNotStarted = false;
						}
					}

					this.toile.drawNodes(
						_get(
							glyph,
							contourSelected.id,
						),
						contourSelected.id,
						[...hotItems, ...selectedItems],
						contourSelected.data.componentIdx === undefined ? '' : `components.${contourSelected.data.componentIdx}.`,
					);
				}

				if (appStateValue & appState.BOX_SELECTING) {
					const [boxStartPosInWorld] = transformCoords(
						[mouseBoxStart],
						inverseProjectionMatrix(this.toile.viewMatrix),
						this.toile.height / this.toile.viewMatrix[0],
					);

					this.toile.drawRectangleFromCorners(mousePosInWorld, boxStartPosInWorld, 'black');
					this.toile.drawAllNodes(glyph, boxedItems);
				}
				if (
					appStateValue & (
						appState.POINTS_SELECTED
						| appState.DRAGGING_POINTS
					)
				) {
					this.toile.drawAllNodes(glyph, selectedItems);
				}

				if (
					this.props.dependencies
					&& (
						appStateValue & (
							appState.CONTOUR_POINT_SELECTED
							| appState.SKELETON_POINT_SELECTED
						)
					)
					&& selectedItems.length === 1
				) {
					const selectedPointDeps = _get(glyph.dependencyTree, selectedItems[0].id);
					const selectedPoint = _get(glyph, selectedItems[0].id);

					if (selectedPointDeps) {
						Object.keys(selectedPointDeps).forEach((key) => {
							const deps = selectedPointDeps[key];

							if (deps instanceof Array) {
								deps.forEach((dep) => {
									if (dep.indexOf('anchor') === -1) {
										const pointAddress = dep.split('.').slice(0, 4).join('.');
										const dependerPoint = _get(glyph, pointAddress);

										this.toile.drawDependencies(dependerPoint, selectedPoint);
									}
								});
							}
						});
					}
				}


				if (
					appStateValue & (
						appState.POINTS_SELECTED
						| appState.CONTOUR_POINT_SELECTED
						| appState.SKELETON_POINT_SELECTED
						| appState.SPACING_SELECTED
					)
				) {
					if (this.toile.keyboardDownRisingEdge.keyCode === 27) {
						this.client.dispatchAction('/reset-glyph-points-manually', {
							glyphName: glyph.base || glyph.name,
							unicode: glyph.unicode,
							points: selectedItems,
						});
					}
				}

				if (appStateValue & appState.MOVING) {
					const [z,,,, tx, ty] = this.toile.viewMatrix;
					const newTs = {
						x: tx + mouse.delta.x,
						y: ty + mouse.delta.y,
					};

					/* if (
						newTs.x !== tx
						|| newTs.y !== ty
					) {
						moving = true;
					} */
					this.setCamera(newTs, z, -height, width);
				}
				else if (appStateValue & appState.ZOOMING) {
					const [z,,,, x, y] = this.toile.viewMatrix;
					const transformMatrix = changeTransformOrigin(
						mousePosInWorld,
						[1 + (mouse.wheel / 1000), 0, 0, 1 + (mouse.wheel / 1000), 0, 0],
					);
					const [zoom,,,, newTx, newTy] = matrixMul(transformMatrix, this.toile.viewMatrix);
					const clampedZoom = Math.max(0.1, Math.min(10, zoom));

					this.setCamera({
						x: z === clampedZoom ? x : newTx,
						y: z === clampedZoom ? y : newTy,
					}, clampedZoom, -height, width);
				}
				/* else {
					moving = false;
				} */

				let interactions = [];

				if (
					appStateValue & (
						appState.DRAGGING_CONTOUR_POINT
						| appState.DRAGGING_POINTS
						| appState.DRAGGING_CONTOUR
					)
				) {
					interactions = selectedItems.map(item => ({
						item,
						modData: mousePosInWorld,
					}));
					mouseMovement = true;
				}
				else if (
					appStateValue & (
						appState.POINTS_SELECTED
						| appState.CONTOUR_POINT_SELECTED
						| appState.SKELETON_POINT_SELECTED
					)
					&& this.toile.keyboardDownRisingEdge.keyCode <= 40
					&& this.toile.keyboardDownRisingEdge.keyCode >= 37
				) {
					mouseMovement = false;
					interactions = selectedItems.map((item) => {
						let posVector;
						const modRange = this.toile.keyboardDown.special & specialKey.SHIFT
							? 10
							: 1;

						if (this.toile.keyboardDownRisingEdge.keyCode === 40) {
							posVector = {x: 0, y: -modRange};
						}
						if (this.toile.keyboardDownRisingEdge.keyCode === 38) {
							posVector = {x: 0, y: modRange};
						}
						if (this.toile.keyboardDownRisingEdge.keyCode === 37) {
							posVector = {x: -modRange, y: 0};
						}
						if (this.toile.keyboardDownRisingEdge.keyCode === 39) {
							posVector = {x: modRange, y: 0};
						}

						return {
							item,
							modData: add2D(_get(glyph, item.id), posVector),
						};
					});
				}
				else if (
					appStateValue & appState.DRAGGING_SPACING
				) {
					interactions = [{
						item: selectedItems[0],
						modData: mousePosInWorld,
					}];
					mouseMovement = true;
				}
				else if (
					appStateValue & appState.SPACING_SELECTED
					&& this.toile.keyboardDownRisingEdge.keyCode <= 40
					&& this.toile.keyboardDownRisingEdge.keyCode >= 37
				) {
					mouseMovement = false;
					const interaction = {
						item: selectedItems[0],
					};

					let baseCoord = 0;

					if (selectedItems[0].id === 'spacingRight') {
						baseCoord = glyph.advanceWidth;
					}

					const modRange = this.toile.keyboardDown.special & specialKey.SHIFT
						? 10
						: 1;

					if (this.toile.keyboardDownRisingEdge.keyCode === 37) {
						interaction.modData = {x: baseCoord - modRange, y: 0};
					}
					if (this.toile.keyboardDownRisingEdge.keyCode === 39) {
						interaction.modData = {x: baseCoord + modRange, y: 0};
					}

					interactions = [interaction];
				}

				if (appStateValue & appState.CONTOUR_POINT_SELECTED) {
					const unparallelMod = this.toile.keyboardDown.special & agnosticCtrl;

					selectedItems.forEach((item) => {
						if (!unparallelMod
							&& (item.type === toileType.NODE_OUT
							|| item.type === toileType.NODE_IN)) {
							const {parallelParameters} = item.data;
							const node = _get(glyph, parallelParameters[1]);

							parallelParameters[0] = node;
							parallelParameters[4] = [{id: parallelParameters[1]}];

							this.toile.drawExpandedNode(...item.data.parallelParameters);
						}
					});
				}


				if (
					appStateValue & (
						appState.DRAGGING_POINTS
						| appState.DRAGGING_CONTOUR_POINT
						| appState.DRAGGING_CONTOUR
						| appState.CONTOUR_POINT_SELECTED
						| appState.SKELETON_POINT_SELECTED
						| appState.POINTS_SELECTED
						| appState.DRAGGING_SPACING
						| appState.SPACING_SELECTED
					)
					&& !draggingNotStarted
				) {
					interactions.forEach((interaction) => {
						const {item, modData} = interaction;

						switch (item.type) {
						case toileType.SPACING_HANDLE: {
							changeSpacing(
								this.client,
								glyph,
								item,
								modData,
							);

							if (item.id === 'spacingLeft') {
								const [z,,,, tx, ty] = this.toile.viewMatrix;
								const newTs = {
									x: tx + modData.x * z,
									y: ty,
								};

								this.setCamera(newTs, z, -height, width);
							}
							break;
						}
						case toileType.NODE_OUT:
						case toileType.NODE_IN: {
							const unsmoothMod = this.toile.keyboardDown.special & specialKey.ALT;
							const unparallelMod = this.toile.keyboardDown.special & agnosticCtrl;

							handleModification(
								this.client,
								glyph,
								item,
								modData,
								unsmoothMod,
								unparallelMod,
							);

							if (!unparallelMod) {
								const {parallelParameters} = item.data;
								const node = _get(glyph, parallelParameters[1]);

								parallelParameters[0] = node;
								parallelParameters[4] = [{id: parallelParameters[1]}];

								this.toile.drawExpandedNode(...item.data.parallelParameters);
							}

							break;
						}
						case toileType.CONTOUR_NODE_OUT:
						case toileType.CONTOUR_NODE_IN: {
							const unsmoothMod = this.toile.keyboardDown.special & specialKey.ALT;

							handleModification(
								this.client,
								glyph,
								item,
								modData,
								unsmoothMod,
								true,
							);
							break;
						}
						case toileType.NODE: {
							let curveMode = onCurveModMode.WIDTH_MOD | onCurveModMode.ANGLE_MOD;

							if (this.toile.keyboardDown.keyCode === 65) {
								curveMode &= ~onCurveModMode.WIDTH_MOD;
							}
							else if (this.toile.keyboardDown.keyCode === 87) {
								curveMode &= ~onCurveModMode.ANGLE_MOD;
							}
							onCurveModification(
								this.client,
								glyph,
								item,
								modData,
								appStateValue,
								curveMode,
							);

							const id = item.data.parentId;
							const skeletonNode = _get(glyph, id);

							if (skeletonNode && !(curveMode & onCurveModMode.ANGLE_MOD)) {
								this.toile.drawWidthTool(skeletonNode);
							}
							if (skeletonNode && !(curveMode & onCurveModMode.WIDTH_MOD)) {
								this.toile.drawAngleTool(skeletonNode);
							}
							break;
						}
						case toileType.NODE_SKELETON:
						case toileType.CONTOUR_NODE: {
							const distrModification = this.toile.keyboardDown.keyCode === 68;

							if (distrModification) {
								skeletonDistrModification(
									this.client,
									glyph,
									item,
									modData,
								);

								const id = item.id;
								const skeletonNode = _get(glyph, id);

								if (skeletonNode) {
									this.toile.drawSkeletonPosTool(skeletonNode, `${id}.pos`, hotItems);
								}
							}
							else {
								const directionalModifier = this.toile.keyboardDown.special & specialKey.SHIFT;

								let posModData = modData;

								if (directionalModifier && !directionalNotStarted && mouseMovement) {
									posModData = {
										x: directionalValue & directionalMod.X ? modData.x : mouseStart.x,
										y: directionalValue & directionalMod.X ? mouseStart.y : modData.y,
									};

									if (directionalValue & directionalMod.Y) {
										this.toile.drawLine(
											{x: posModData.x, y: 1000000},
											{x: posModData.x, y: -1000000},
											'#ff00ff',
										);
									}
									else {
										this.toile.drawLine(
											{y: posModData.y, x: 1000000},
											{y: posModData.y, x: -1000000},
											'#ff00ff',
										);
									}
								}


								skeletonPosModification(
									this.client,
									glyph,
									item,
									posModData,
								);

								const id = item.id;
								const skeletonNode = _get(glyph, id);

								if (skeletonNode) {
									this.toile.drawSkeletonPosTool(skeletonNode, `${id}.pos`, hotItems);
								}
							}
							break;
						}
						default:
							break;
						}
					});
				}

				if (selectedItems.length === 1) {
					const interactedItem = selectedItems[0];

					if (interactedItem.type === toileType.NODE_SKELETON) {
						const item = _get(glyph, interactedItem.id);

						this.toile.drawNodeProperty(interactedItem.type, item);
					}
					if (interactedItem.type === toileType.NODE) {
						const item = _get(glyph, interactedItem.id);
						const parent = _get(glyph, interactedItem.data.parentId);

						this.toile.drawNodeProperty(interactedItem.type, item, parent);
					}
					if (interactedItem.type === toileType.CONTOUR_NODE) {
						const item = _get(glyph, interactedItem.id);
						const parent = _get(glyph, interactedItem.data.parentId);

						this.toile.drawNodeProperty(interactedItem.type, item, parent);
					}
					if (
						interactedItem.type === toileType.NODE_OUT
						|| interactedItem.type === toileType.NODE_IN
						|| interactedItem.type === toileType.CONTOUR_NODE_OUT
						|| interactedItem.type === toileType.CONTOUR_NODE_IN
					) {
						const item = _get(glyph, interactedItem.id);
						const parent = _get(glyph, interactedItem.data.parentId);

						this.toile.drawNodeProperty(interactedItem.type, item, parent);
					}
				}
			}

			this.cleanUpFrame();

			rafId = raf(rafFunc);
			/* eslint-enable no-bitwise, max-depth */
		};

		rafId = raf(rafFunc);
	}

	cleanUpFrame() {
		this.toile.clearKeyboardEdges();
		this.toile.clearMouseEdges();
		this.toile.clearDelta();
		this.toile.clearWheelDelta();
	}

	componentWillUnmount() {
		this.lifespan.release();
		rafCancel(rafId);
	}

	changeParam(param) {
		return (e) => {
			const params = {
				values: {
					...this.state.values,
					[param]: parseFloat(e),
					trigger: false,
				},
				demo: true,
			};

			this.client.dispatchAction('/change-param', params);
		};
	}

	download() {
		const params = {
			values: {
				...this.state.values,
				trigger: true,
			},
			demo: true,
		};

		this.client.dispatchAction('/change-param', params);
	}

	resetView(glyph, height, width) {
		const bbox = glyphBoundingBox(glyph);
		const center = mulScalar2D(1 / 2, add2D(
			bbox[0],
			bbox[1],
		));

		this.setCameraCenter(center, 0.5, -height, width);
	}

	setCamera(t, z, height, width) {
		this.toile.setCamera(t, z, height, width);
		this.client.dispatchAction('/store-value', {
			glyphViewMatrix: {
				t,
				z,
			},
		});
	}

	setCameraCenter(t, z, height, width) {
		this.toile.setCameraCenter(t, z, height, width);
	}

	storeSelectedItems(selectedItems) {
		const storedItems = selectedItems.map(item => ({
			type: item.type,
			id: item.id,
			data: {
				parentId: item.data.parentId,
				modifAddress: item.data.modifAddress,
			},
		}));

		this.client.dispatchAction('/store-value', {
			selectedItems: storedItems,
		});
	}

	render() {
		return (
			<div className="prototypo-canvas-container">
				<canvas
					id="hello"
					ref={(canvas) => {this.canvas = canvas;}}
					style={{
						width: '100%', height: '100%', WebkitUserDrag: 'none', userSelect: 'none', WebkitTapHighlightColor: 'rgba(0, 0, 0, 0)',
					}}
				/>
				<FontUpdater />
			</div>
		);
	}
}
