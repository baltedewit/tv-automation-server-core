import * as React from 'react'
import * as _ from 'underscore'
import * as Velocity from 'velocity-animate'
import { Translated, translateWithTracker } from '../../lib/ReactMeteorData/react-meteor-data'
import { translate } from 'react-i18next'
import { Rundown } from '../../../lib/collections/Rundowns'
import { Segment } from '../../../lib/collections/Segments'
import { Part } from '../../../lib/collections/Parts'
import { AdLibPiece } from '../../../lib/collections/AdLibPieces'
import { AdLibListItem } from './AdLibListItem'
import * as ClassNames from 'classnames'
import { mousetrapHelper } from '../../lib/mousetrapHelper'

import * as faTh from '@fortawesome/fontawesome-free-solid/faTh'
import * as faList from '@fortawesome/fontawesome-free-solid/faList'
import * as faTimes from '@fortawesome/fontawesome-free-solid/faTimes'
import * as FontAwesomeIcon from '@fortawesome/react-fontawesome'

import { Spinner } from '../../lib/Spinner'
import { MeteorReactComponent } from '../../lib/MeteorReactComponent'
import { RundownViewKbdShortcuts } from '../RundownView'
import { ShowStyleBase } from '../../../lib/collections/ShowStyleBases'
import { IOutputLayer, ISourceLayer } from 'tv-automation-sofie-blueprints-integration'
import { PubSub, meteorSubscribe } from '../../../lib/api/pubsub'
import { doUserAction } from '../../lib/userAction'
import { UserActionAPI } from '../../../lib/api/userActions'
import { NotificationCenter, Notification, NoticeLevel } from '../../lib/notifications/notifications'
import { RundownLayoutFilter, DashboardLayoutFilter } from '../../../lib/collections/RundownLayouts'
import { RundownBaselineAdLibPieces } from '../../../lib/collections/RundownBaselineAdLibPieces'
import { Random } from 'meteor/random'
import { literal, getCurrentTime } from '../../../lib/lib'
import { RundownAPI } from '../../../lib/api/rundown'
import { IAdLibPanelProps, IAdLibPanelTrackedProps, fetchAndFilter, AdLibPieceUi, matchFilter, AdLibPanelToolbar } from './AdLibPanel'
import { DashboardPieceButton } from './DashboardPieceButton'
import { ensureHasTrailingSlash } from '../../lib/lib'
import { Studio } from '../../../lib/collections/Studios'
import { Piece, Pieces } from '../../../lib/collections/Pieces'
import { invalidateAt } from '../../lib/invalidatingTime'

interface IState {
	outputLayers: {
		[key: string]: IOutputLayer
	}
	sourceLayers: {
		[key: string]: ISourceLayer
	},
	searchFilter: string | undefined
}

interface IDashboardPanelProps {
}

interface IDashboardPanelTrackedProps {
	studio?: Studio
	unfinishedPieces: {
		[key: string]: Piece[]
	}
}

interface DashboardPositionableElement {
	x: number
	y: number
	width: number
	height: number
}

export function dashboardElementPosition (el: DashboardPositionableElement): React.CSSProperties {
	return {
		width: el.width >= 0 ?
			`calc((${el.width} * var(--dashboard-button-grid-width)) + var(--dashboard-panel-margin-width))` :
			undefined,
		height: el.height >= 0 ?
			`calc((${el.height} * var(--dashboard-button-grid-height)) + var(--dashboard-panel-margin-height))` :
			undefined,
		left: el.x >= 0 ?
			`calc(${el.x} * var(--dashboard-button-grid-width))` :
			el.width < 0 ?
				`calc(${-1 * el.width - 1} * var(--dashboard-button-grid-width))` :
				undefined,
		top: el.y >= 0 ?
			`calc(${el.y} * var(--dashboard-button-grid-height))` :
			el.height < 0 ?
				`calc(${-1 * el.height - 1} * var(--dashboard-button-grid-height))` :
				undefined,
		right: el.x < 0 ?
			`calc(${-1 * el.x - 1} * var(--dashboard-button-grid-width))` :
			el.width < 0 ?
				`calc(${-1 * el.width - 1} * var(--dashboard-button-grid-width))` :
				undefined,
		bottom: el.y < 0 ?
			`calc(${-1 * el.y - 1} * var(--dashboard-button-grid-height))` :
			el.height < 0 ?
				`calc(${-1 * el.height - 1} * var(--dashboard-button-grid-height))` :
				undefined
	}
}

export class DashboardPanelInner extends MeteorReactComponent<Translated<IAdLibPanelProps & IDashboardPanelProps & IAdLibPanelTrackedProps & IDashboardPanelTrackedProps>, IState> {
	usedHotkeys: Array<string> = []

	constructor (props: Translated<IAdLibPanelProps & IAdLibPanelTrackedProps>) {
		super(props)

		this.state = {
			outputLayers: {},
			sourceLayers: {},
			searchFilter: undefined
		}
	}

	static getDerivedStateFromProps (props: IAdLibPanelProps, state) {
		let tOLayers: {
			[key: string]: IOutputLayer
		} = {}
		let tSLayers: {
			[key: string]: ISourceLayer
		} = {}

		if (props.showStyleBase && props.showStyleBase.outputLayers && props.showStyleBase.sourceLayers) {
			props.showStyleBase.outputLayers.forEach((item) => {
				tOLayers[item._id] = item
			})
			props.showStyleBase.sourceLayers.forEach((item) => {
				tSLayers[item._id] = item
			})

			return _.extend(state, {
				outputLayers: tOLayers,
				sourceLayers: tSLayers
			})
		} else {
			return state
		}
	}

	componentDidMount () {
		this.subscribe(PubSub.segments, {
			rundownId: this.props.rundown._id
		})
		this.subscribe(PubSub.parts, {
			rundownId: this.props.rundown._id
		})
		this.subscribe(PubSub.pieces, {
			rundownId: this.props.rundown._id,
			startedPlayback: {
				$exists: true
			},
			adLibSourceId: {
				$exists: true
			},
			$or: [{
				stoppedPlayback: {
					$eq: 0
				}
			}, {
				stoppedPlayback: {
					$exists: false
				}
			}]
		})
		this.subscribe(PubSub.adLibPieces, {
			rundownId: this.props.rundown._id
		})
		this.subscribe(PubSub.rundownBaselineAdLibPieces, {
			rundownId: this.props.rundown._id
		})
		this.subscribe(PubSub.studios, {
			_id: this.props.rundown.studioId
		})
		this.subscribe(PubSub.showStyleBases, {
			_id: this.props.rundown.showStyleBaseId
		})

		this.refreshKeyboardHotkeys()
	}

	componentDidUpdate (prevProps: IAdLibPanelProps & IAdLibPanelTrackedProps) {
		mousetrapHelper.unbindAll(this.usedHotkeys, 'keyup', this.constructor.name)
		mousetrapHelper.unbindAll(this.usedHotkeys, 'keydown', this.constructor.name)
		this.usedHotkeys.length = 0

		this.refreshKeyboardHotkeys()
	}

	componentWillUnmount () {
		this._cleanUp()
		mousetrapHelper.unbindAll(this.usedHotkeys, 'keyup', this.constructor.name)
		mousetrapHelper.unbindAll(this.usedHotkeys, 'keydown', this.constructor.name)

		this.usedHotkeys.length = 0
	}

	isAdLibOnAir (adLib: AdLibPieceUi) {
		if (this.props.unfinishedPieces[adLib._id] && this.props.unfinishedPieces[adLib._id].length > 0) {
			return true
		}
		return false
	}

	refreshKeyboardHotkeys () {
		if (!this.props.studioMode) return
		if (!this.props.registerHotkeys) return

		let preventDefault = (e) => {
			e.preventDefault()
		}

		if (this.props.liveSegment && this.props.liveSegment.pieces) {
			this.props.liveSegment.pieces.forEach((item) => {
				if (item.hotkey) {
					mousetrapHelper.bind(item.hotkey, preventDefault, 'keydown', this.constructor.name)
					mousetrapHelper.bind(item.hotkey, (e: ExtendedKeyboardEvent) => {
						preventDefault(e)
						this.onToggleAdLib(item, false, e)
					}, 'keyup', this.constructor.name)
					this.usedHotkeys.push(item.hotkey)

					const sourceLayer = this.props.sourceLayerLookup[item.sourceLayerId]
					if (sourceLayer && sourceLayer.isQueueable) {
						const queueHotkey = [RundownViewKbdShortcuts.ADLIB_QUEUE_MODIFIER, item.hotkey].join('+')
						mousetrapHelper.bind(queueHotkey, preventDefault, 'keydown', this.constructor.name)
						mousetrapHelper.bind(queueHotkey, (e: ExtendedKeyboardEvent) => {
							preventDefault(e)
							this.onToggleAdLib(item, true, e)
						}, 'keyup', this.constructor.name)
						this.usedHotkeys.push(queueHotkey)
					}
				}
			})
		}

		if (this.props.rundownBaselineAdLibs) {
			this.props.rundownBaselineAdLibs.forEach((item) => {
				if (item.hotkey) {
					mousetrapHelper.bind(item.hotkey, preventDefault, 'keydown', this.constructor.name)
					mousetrapHelper.bind(item.hotkey, (e: ExtendedKeyboardEvent) => {
						preventDefault(e)
						this.onToggleAdLib(item, false, e)
					}, 'keyup', this.constructor.name)
					this.usedHotkeys.push(item.hotkey)

					const sourceLayer = this.props.sourceLayerLookup[item.sourceLayerId]
					if (sourceLayer && sourceLayer.isQueueable) {
						const queueHotkey = [RundownViewKbdShortcuts.ADLIB_QUEUE_MODIFIER, item.hotkey].join('+')
						mousetrapHelper.bind(queueHotkey, preventDefault, 'keydown', this.constructor.name)
						mousetrapHelper.bind(queueHotkey, (e: ExtendedKeyboardEvent) => {
							preventDefault(e)
							this.onToggleAdLib(item, true, e)
						}, 'keyup', this.constructor.name)
						this.usedHotkeys.push(queueHotkey)
					}
				}
			})
		}

		if (this.props.sourceLayerLookup) {

			const clearKeyboardHotkeySourceLayers: {[hotkey: string]: ISourceLayer[]} = {}

			_.each(this.props.sourceLayerLookup, (sourceLayer) => {
				if (sourceLayer.clearKeyboardHotkey) {
					sourceLayer.clearKeyboardHotkey.split(',').forEach(hotkey => {
						if (!clearKeyboardHotkeySourceLayers[hotkey]) clearKeyboardHotkeySourceLayers[hotkey] = []
						clearKeyboardHotkeySourceLayers[hotkey].push(sourceLayer)
					})
				}

				if (sourceLayer.isSticky && sourceLayer.activateStickyKeyboardHotkey) {
					sourceLayer.activateStickyKeyboardHotkey.split(',').forEach(element => {
						mousetrapHelper.bind(element, preventDefault, 'keydown', this.constructor.name)
						mousetrapHelper.bind(element, (e: ExtendedKeyboardEvent) => {
							preventDefault(e)
							this.onToggleSticky(sourceLayer._id, e)
						}, 'keyup', this.constructor.name)
						this.usedHotkeys.push(element)
					})
				}
			})

			_.each(clearKeyboardHotkeySourceLayers, (sourceLayers, hotkey) => {
				mousetrapHelper.bind(hotkey, preventDefault, 'keydown', this.constructor.name)
				mousetrapHelper.bind(hotkey, (e: ExtendedKeyboardEvent) => {
					preventDefault(e)
					this.onClearAllSourceLayers(sourceLayers, e)
				}, 'keyup', this.constructor.name)
				this.usedHotkeys.push(hotkey)
			})
		}
	}

	onToggleAdLib = (piece: AdLibPieceUi, queue: boolean, e: any) => {
		const { t } = this.props

		if (piece.invalid) {
			NotificationCenter.push(new Notification(
				t('Invalid AdLib'),
				NoticeLevel.WARNING,
				t('Cannot play this AdLib because it is marked as Invalid'),
				'toggleAdLib'))
			return
		}

		let sourceLayer = this.props.sourceLayerLookup && this.props.sourceLayerLookup[piece.sourceLayerId]

		if (queue && sourceLayer && sourceLayer.isQueueable) {
			console.log(`Item "${piece._id}" is on sourceLayer "${piece.sourceLayerId}" that is not queueable.`)
			return
		}
		if (this.props.rundown && this.props.rundown.currentPartId) {
			if (!this.isAdLibOnAir(piece) || !(sourceLayer && sourceLayer.clearKeyboardHotkey)) {
				if (!piece.isGlobal) {
					doUserAction(t, e, UserActionAPI.methods.segmentAdLibPieceStart, [
						this.props.rundown._id, this.props.rundown.currentPartId, piece._id, queue || false
					])
				} else if (piece.isGlobal && !piece.isSticky) {
					doUserAction(t, e, UserActionAPI.methods.baselineAdLibPieceStart, [
						this.props.rundown._id, this.props.rundown.currentPartId, piece._id, queue || false
					])
				} else if (piece.isSticky) {
					this.onToggleSticky(piece.sourceLayerId, e)
				}
			} else {
				if (sourceLayer && sourceLayer.clearKeyboardHotkey) {
					this.onClearAllSourceLayers([sourceLayer], e)
				}
			}
		}
	}

	onToggleSticky = (sourceLayerId: string, e: any) => {
		if (this.props.rundown && this.props.rundown.currentPartId && this.props.rundown.active) {
			const { t } = this.props
			doUserAction(t, e, UserActionAPI.methods.sourceLayerStickyPieceStart, [this.props.rundown._id, sourceLayerId])
		}
	}

	onClearAllSourceLayers = (sourceLayers: ISourceLayer[], e: any) => {
		// console.log(sourceLayer)
		const { t } = this.props
		if (this.props.rundown && this.props.rundown.currentPartId) {
			doUserAction(t, e, UserActionAPI.methods.sourceLayerOnPartStop, [
				this.props.rundown._id, this.props.rundown.currentPartId, _.map(sourceLayers, sl => sl._id)
			])
		}
	}

	onFilterChange = (filter: string) => {
		this.setState({
			searchFilter: filter
		})
	}

	render () {
		if (this.props.visible && this.props.showStyleBase && this.props.filter) {
			const filter = this.props.filter as DashboardLayoutFilter
			if (!this.props.uiSegments || !this.props.rundown) {
				return <Spinner />
			} else {
				return (
					<div className='dashboard-panel'
						style={dashboardElementPosition(filter)}
					>
						<h4 className='dashboard-panel__header'>
							{this.props.filter.name}
						</h4>
						{ filter.enableSearch &&
							<AdLibPanelToolbar
								onFilterChange={this.onFilterChange} />
						}
						<div className={ClassNames('dashboard-panel__panel', {
							'dashboard-panel__panel--horizontal': filter.overflowHorizontally
						})}>
							{this.props.rundownBaselineAdLibs
								.concat(_.flatten(this.props.uiSegments.map(seg => seg.pieces)))
								.filter((item) => matchFilter(item, this.props.showStyleBase, this.props.uiSegments, this.props.filter, this.state.searchFilter))
								.map((item: AdLibPieceUi) => {
									return <DashboardPieceButton
												key={item._id}
												item={item}
												layer={this.state.sourceLayers[item.sourceLayerId]}
												outputLayer={this.state.outputLayers[item.outputLayerId]}
												onToggleAdLib={this.onToggleAdLib}
												rundown={this.props.rundown}
												isOnAir={this.isAdLibOnAir(item)}
												mediaPreviewUrl={this.props.studio ? ensureHasTrailingSlash(this.props.studio.settings.mediaPreviewsUrl + '' || '') || '' : ''}
												widthScale={filter.buttonWidthScale}
												heightScale={filter.buttonHeightScale}
											>
												{item.name}
									</DashboardPieceButton>
								})}
						</div>
					</div>
				)
			}
		}
		return null
	}
}

export function getUnfinishedPiecesReactive (rundownId: string, currentPartId: string | null) {
	let prospectivePieces: Piece[] = []
	const now = getCurrentTime()
	if (currentPartId) {
		prospectivePieces = Pieces.find({
			rundownId: rundownId,
			partId: currentPartId,
			startedPlayback: {
				$exists: true
			},
			$or: [{
				stoppedPlayback: {
					$eq: 0
				}
			}, {
				stoppedPlayback: {
					$exists: false
				}
			}],
			playoutDuration: {
				$exists: false
			},
			adLibSourceId: {
				$exists: true
			}
		}).fetch()

		let nearestEnd = Number.POSITIVE_INFINITY
		prospectivePieces = prospectivePieces.filter((piece) => {
			let duration: number | undefined =
				(piece.playoutDuration) ?
					piece.playoutDuration :
				(piece.userDuration && typeof piece.userDuration.duration === 'number') ?
					piece.userDuration.duration :
				(piece.userDuration && typeof piece.userDuration.end === 'string') ?
					0 : // TODO: obviously, it would be best to evaluate this, but for now we assume that userDuration of any sort is probably in the past
				(typeof piece.enable.duration === 'number') ?
					piece.enable.duration :
					undefined

			if (duration !== undefined) {
				const end = (piece.startedPlayback! + duration)
				if (end > now) {
					nearestEnd = nearestEnd > end ? end : nearestEnd
					return true
				} else {
					return false
				}
			}
			return true
		})

		if (Number.isFinite(nearestEnd)) invalidateAt(nearestEnd)
	}

	return _.groupBy(prospectivePieces, (piece) => piece.adLibSourceId)
}

export const DashboardPanel = translateWithTracker<IAdLibPanelProps & IDashboardPanelProps, IState, IAdLibPanelTrackedProps & IDashboardPanelTrackedProps>((props: Translated<IAdLibPanelProps>) => {
	return Object.assign({}, fetchAndFilter(props), {
		studio: props.rundown.getStudio(),
		unfinishedPieces: getUnfinishedPiecesReactive(props.rundown._id, props.rundown.currentPartId)
	})
}, (data, props: IAdLibPanelProps, nextProps: IAdLibPanelProps) => {
	return !_.isEqual(props, nextProps)
})(DashboardPanelInner)

