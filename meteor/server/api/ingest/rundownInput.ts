import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import * as _ from 'underscore'
import { PeripheralDevice } from '../../../lib/collections/PeripheralDevices'
import {
	Rundown,
	Rundowns,
	DBRundown
} from '../../../lib/collections/Rundowns'
import {
	Part,
	Parts,
	DBPart
} from '../../../lib/collections/Parts'
import {
	Piece,
	Pieces
} from '../../../lib/collections/Pieces'
import {
	saveIntoDb,
	getCurrentTime,
	literal,
	sumChanges,
	anythingChanged,
	ReturnType,
	asyncCollectionUpsert,
	asyncCollectionUpdate,
	waitForPromise,
	PreparedChanges,
	prepareSaveIntoDb,
	savePreparedChanges,
	Optional
} from '../../../lib/lib'
import { PeripheralDeviceSecurity } from '../../security/peripheralDevices'
import { IngestRundown, IngestSegment, IngestPart, BlueprintResultSegment } from 'tv-automation-sofie-blueprints-integration'
import { logger } from '../../../lib/logging'
import { Studio } from '../../../lib/collections/Studios'
import { selectShowStyleVariant, afterRemoveSegments, afterRemoveParts, ServerRundownAPI, removeSegments, updatePartRanks } from '../rundown'
import { loadShowStyleBlueprints, getBlueprintOfRundown } from '../blueprints/cache'
import { ShowStyleContext, RundownContext, SegmentContext } from '../blueprints/context'
import { Blueprints, Blueprint } from '../../../lib/collections/Blueprints'
import { RundownBaselineObj, RundownBaselineObjs } from '../../../lib/collections/RundownBaselineObjs'
import { Random } from 'meteor/random'
import { postProcessRundownBaselineItems, postProcessAdLibPieces, postProcessPieces } from '../blueprints/postProcess'
import { RundownBaselineAdLibItem, RundownBaselineAdLibPieces } from '../../../lib/collections/RundownBaselineAdLibPieces'
import { DBSegment, Segments, Segment } from '../../../lib/collections/Segments'
import { AdLibPiece, AdLibPieces } from '../../../lib/collections/AdLibPieces'
import { saveRundownCache, saveSegmentCache, loadCachedIngestSegment, loadCachedRundownData } from './ingestCache'
import { getRundownId, getSegmentId, getPartId, getStudioFromDevice, getRundown, canBeUpdated } from './lib'
import { PackageInfo } from '../../coreSystem'
import { updateExpectedMediaItemsOnRundown } from '../expectedMediaItems'
import { triggerUpdateTimelineAfterIngestData } from '../playout/playout'
import { PartNote, NoteType } from '../../../lib/api/notes'
import { syncFunction } from '../../codeControl'
import { updateSourceLayerInfinitesAfterPart } from '../playout/infinites'
import { UpdateNext } from './updateNext'
import { extractExpectedPlayoutItems, updateExpectedPlayoutItemsOnRundown } from './expectedPlayoutItems'
import { ExpectedPlayoutItem, ExpectedPlayoutItems } from '../../../lib/collections/ExpectedPlayoutItems'

export enum RundownSyncFunctionPriority {
	Ingest = 0,
	Playout = 10,
}
export function rundownSyncFunction<T extends Function> (rundownId: string, priority: RundownSyncFunctionPriority, fcn: T): ReturnType<T> {
	return syncFunction(fcn, `ingest_rundown_${rundownId}`, undefined, priority)()
}

export namespace RundownInput {
	// Get info on the current rundowns from this device:
	export function dataRundownList (self: any, deviceId: string, deviceToken: string) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataRundownList')
		return listIngestRundowns(peripheralDevice)
	}
	export function dataRundownGet (self: any, deviceId: string, deviceToken: string, rundownExternalId: string) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataRundownGet', rundownExternalId)
		check(rundownExternalId, String)
		return getIngestRundown(peripheralDevice, rundownExternalId)
	}
	// Delete, Create & Update Rundown (and it's contents):
	export function dataRundownDelete (self: any, deviceId: string, deviceToken: string, rundownExternalId: string) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataRundownDelete', rundownExternalId)
		check(rundownExternalId, String)
		handleRemovedRundown(peripheralDevice, rundownExternalId)
	}
	export function dataRundownCreate (self: any, deviceId: string, deviceToken: string, ingestRundown: IngestRundown) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataRundownCreate', ingestRundown)
		check(ingestRundown, Object)
		handleUpdatedRundown(peripheralDevice, ingestRundown, 'dataRundownCreate')
	}
	export function dataRundownUpdate (self: any, deviceId: string, deviceToken: string, ingestRundown: IngestRundown) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataRundownUpdate', ingestRundown)
		check(ingestRundown, Object)
		handleUpdatedRundown(peripheralDevice, ingestRundown, 'dataRundownUpdate')
	}
	// Delete, Create & Update Segment (and it's contents):
	export function dataSegmentDelete (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, segmentExternalId: string) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataSegmentDelete', rundownExternalId, segmentExternalId)
		check(rundownExternalId, String)
		check(segmentExternalId, String)
		handleRemovedSegment(peripheralDevice, rundownExternalId, segmentExternalId)
	}
	export function dataSegmentCreate (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, ingestSegment: IngestSegment) {
		let peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataSegmentCreate', rundownExternalId, ingestSegment)
		check(rundownExternalId, String)
		check(ingestSegment, Object)
		handleUpdatedSegment(peripheralDevice, rundownExternalId, ingestSegment)
	}
	export function dataSegmentUpdate (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, ingestSegment: IngestSegment) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataSegmentUpdate', rundownExternalId, ingestSegment)
		check(rundownExternalId, String)
		check(ingestSegment, Object)
		handleUpdatedSegment(peripheralDevice, rundownExternalId, ingestSegment)
	}
	// Delete, Create & Update Part:
	export function dataPartDelete (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, segmentExternalId: string, partExternalId: string) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataPartDelete', rundownExternalId, segmentExternalId, partExternalId)
		check(rundownExternalId, String)
		check(segmentExternalId, String)
		check(partExternalId, String)
		handleRemovedPart(peripheralDevice, rundownExternalId, segmentExternalId, partExternalId)
	}
	export function dataPartCreate (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, segmentExternalId: string, ingestPart: IngestPart) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataPartCreate', rundownExternalId, segmentExternalId, ingestPart)
		check(rundownExternalId, String)
		check(segmentExternalId, String)
		check(ingestPart, Object)
		handleUpdatedPart(peripheralDevice, rundownExternalId, segmentExternalId, ingestPart)
	}
	export function dataPartUpdate (self: any, deviceId: string, deviceToken: string, rundownExternalId: string, segmentExternalId: string, ingestPart: IngestPart) {
		const peripheralDevice = PeripheralDeviceSecurity.getPeripheralDevice(deviceId, deviceToken, self)
		logger.info('dataPartUpdate', rundownExternalId, segmentExternalId, ingestPart)
		check(rundownExternalId, String)
		check(segmentExternalId, String)
		check(ingestPart, Object)
		handleUpdatedPart(peripheralDevice, rundownExternalId, segmentExternalId, ingestPart)
	}
}

function getIngestRundown (peripheralDevice: PeripheralDevice, rundownExternalId: string): IngestRundown {
	const rundown = Rundowns.findOne({
		peripheralDeviceId: peripheralDevice._id,
		externalId: rundownExternalId
	})
	if (!rundown) {
		throw new Meteor.Error(404, `Rundown ${rundownExternalId} does not exist`)
	}

	return loadCachedRundownData(rundown._id, rundown.externalId)
}
function listIngestRundowns (peripheralDevice: PeripheralDevice): string[] {
	const rundowns = Rundowns.find({
		peripheralDeviceId: peripheralDevice._id
	}).fetch()

	return rundowns.map(r => r.externalId)
}

export function handleRemovedRundown (peripheralDevice: PeripheralDevice, rundownExternalId: string) {
	const studio = getStudioFromDevice(peripheralDevice)
	const rundownId = getRundownId(studio, rundownExternalId)

	rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => {
		const rundown = getRundown(rundownId, rundownExternalId)
		if (rundown) {

			if (canBeUpdated(rundown)) {
				if (!isUpdateAllowed(rundown, { removed: [rundown] }, {}, {})) {
					ServerRundownAPI.unsyncRundown(rundown._id)
				} else {
					logger.info(`Removing rundown "${rundown._id}"`)
					rundown.remove()
				}
			} else {
				logger.info(`Rundown "${rundown._id}" cannot be updated`)
				if (!rundown.unsynced) {
					ServerRundownAPI.unsyncRundown(rundown._id)
				}
			}
		}
	})
}
export function handleUpdatedRundown (peripheralDevice: PeripheralDevice, ingestRundown: IngestRundown, dataSource: string) {
	const studio = getStudioFromDevice(peripheralDevice)
	handleUpdatedRundownForStudio(studio, peripheralDevice, ingestRundown, dataSource)
}
export function handleUpdatedRundownForStudio (studio: Studio, peripheralDevice: PeripheralDevice | undefined, ingestRundown: IngestRundown, dataSource: string) {
	const rundownId = getRundownId(studio, ingestRundown.externalId)
	if (peripheralDevice && peripheralDevice.studioId !== studio._id) {
		throw new Meteor.Error(500, `PeripheralDevice "${peripheralDevice._id}" does not belong to studio "${studio._id}"`)
	}

	return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => handleUpdatedRundownInner(studio, rundownId, ingestRundown, dataSource, peripheralDevice))
}
export function handleUpdatedRundownInner (studio: Studio, rundownId: string, ingestRundown: IngestRundown, dataSource?: string, peripheralDevice?: PeripheralDevice) {
	const existingDbRundown = Rundowns.findOne(rundownId)
	if (!canBeUpdated(existingDbRundown)) return

	updateRundownAndSaveCache(studio, rundownId, existingDbRundown, ingestRundown, dataSource, peripheralDevice)
}
export function updateRundownAndSaveCache (
	studio: Studio,
	rundownId: string,
	existingDbRundown: Rundown | undefined,
	ingestRundown: IngestRundown,
	dataSource?: string,
	peripheralDevice?: PeripheralDevice) {
	logger.info((existingDbRundown ? 'Updating' : 'Adding') + ' rundown ' + rundownId)

	saveRundownCache(rundownId, ingestRundown)

	updateRundownFromIngestData(studio, existingDbRundown, ingestRundown, dataSource, peripheralDevice)
}
function updateRundownFromIngestData (
	studio: Studio,
	existingDbRundown: Rundown | undefined,
	ingestRundown: IngestRundown,
	dataSource?: string,
	peripheralDevice?: PeripheralDevice
): boolean {
	const rundownId = getRundownId(studio, ingestRundown.externalId)

	const showStyle = selectShowStyleVariant(studio, ingestRundown)
	if (!showStyle) {
		logger.debug('Blueprint rejected the rundown')
		throw new Meteor.Error(501, 'Blueprint rejected the rundown')
	}

	const showStyleBlueprint = loadShowStyleBlueprints(showStyle.base).blueprint
	const blueprintContext = new ShowStyleContext(studio, showStyle.base._id, showStyle.variant._id)
	const rundownRes = showStyleBlueprint.getRundown(blueprintContext, ingestRundown)

	// Ensure the ids in the notes are clean
	const rundownNotes = _.map(blueprintContext.getNotes(), note => literal<PartNote>({
		...note,
		origin: {
			name: note.origin.name,
			rundownId: rundownId,
		}
	}))

	const showStyleBlueprintDb = Blueprints.findOne(showStyle.base.blueprintId) as Blueprint || {}

	const dbRundownData: DBRundown = _.extend(existingDbRundown || {},
		_.omit(literal<DBRundown>({
			...rundownRes.rundown,
			notes: rundownNotes,
			_id: rundownId,
			externalId: ingestRundown.externalId,
			studioId: studio._id,
			showStyleVariantId: showStyle.variant._id,
			showStyleBaseId: showStyle.base._id,
			unsynced: false,

			importVersions: {
				studio: studio._rundownVersionHash,
				showStyleBase: showStyle.base._rundownVersionHash,
				showStyleVariant: showStyle.variant._rundownVersionHash,
				blueprint: showStyleBlueprintDb.blueprintVersion,
				core: PackageInfo.version,
			},

			// omit the below fields
			previousPartId: null,
			currentPartId: null,
			nextPartId: null,
			created: 0,
			modified: 0,

			peripheralDeviceId: '', // added later
			dataSource: '' // added later
		}), ['previousPartId', 'currentPartId', 'nextPartId', 'created', 'modified', 'peripheralDeviceId', 'dataSource'])
	)
	if (peripheralDevice) {
		dbRundownData.peripheralDeviceId = peripheralDevice._id
	} else {
		// TODO - this needs to set something..
	}
	if (dataSource) {
		dbRundownData.dataSource = dataSource
	}

	// Save rundown into database:
	let changes = saveIntoDb(Rundowns, {
		_id: dbRundownData._id
	}, [dbRundownData], {
		beforeInsert: (o) => {
			o.modified = getCurrentTime()
			o.created = getCurrentTime()
			o.previousPartId = null
			o.currentPartId = null
			o.nextPartId = null
			return o
		},
		beforeUpdate: (o) => {
			o.modified = getCurrentTime()
			return o
		}
	})

	const dbRundown = Rundowns.findOne(dbRundownData._id)
	if (!dbRundown) throw new Meteor.Error(500, 'Rundown not found (it should have been)')

	// Save the baseline
	const blueprintRundownContext = new RundownContext(dbRundown, studio)
	logger.info(`Building baseline objects for ${dbRundown._id}...`)
	logger.info(`... got ${rundownRes.baseline.length} objects from baseline.`)

	const baselineObj: RundownBaselineObj = {
		_id: Random.id(7),
		rundownId: dbRundown._id,
		objects: postProcessRundownBaselineItems(blueprintRundownContext, rundownRes.baseline)
	}
	// Save the global adlibs
	logger.info(`... got ${rundownRes.globalAdLibPieces.length} adLib objects from baseline.`)
	const adlibItems = postProcessAdLibPieces(blueprintRundownContext, rundownRes.globalAdLibPieces, 'baseline')

	const existingRundownParts = Parts.find({
		rundownId: dbRundown._id,
		dynamicallyInserted: { $ne: true }
	}).fetch()

	const existingSegments = Segments.find({ rundownId: dbRundown._id }).fetch()
	const segments: DBSegment[] = []
	const parts: DBPart[] = []
	const segmentPieces: Piece[] = []
	const adlibPieces: AdLibPiece[] = []

	const { blueprint, blueprintId } = getBlueprintOfRundown(dbRundown)

	_.each(ingestRundown.segments, (ingestSegment: IngestSegment) => {
		const segmentId = getSegmentId(rundownId, ingestSegment.externalId)
		const existingSegment = _.find(existingSegments, s => s._id === segmentId)
		const existingParts = existingRundownParts.filter(p => p.segmentId === segmentId)

		ingestSegment.parts = _.sortBy(ingestSegment.parts, part => part.rank)

		const context = new SegmentContext(dbRundown, studio, existingParts)
		context.handleNotesExternally = true
		const res = blueprint.getSegment(context, ingestSegment)

		const segmentContents = generateSegmentContents(context, blueprintId, ingestSegment, existingSegment, existingParts, res)
		segments.push(segmentContents.newSegment)
		parts.push(...segmentContents.parts)
		segmentPieces.push(...segmentContents.segmentPieces)
		adlibPieces.push(...segmentContents.adlibPieces)
	})


	// Prepare updates:
	const prepareSaveSegments = prepareSaveIntoDb(Segments, {
		rundownId: rundownId
	}, segments)
	const prepareSaveParts = prepareSaveIntoDb<Part, DBPart>(Parts, {
		rundownId: rundownId,
	}, parts)
	const prepareSavePieces = prepareSaveIntoDb<Piece, Piece>(Pieces, {
		rundownId: rundownId,
		dynamicallyInserted: { $ne: true } // do not affect dynamically inserted pieces (such as adLib pieces)
	}, segmentPieces)
	const prepareSaveAdLibPieces = prepareSaveIntoDb<AdLibPiece, AdLibPiece>(AdLibPieces, {
		rundownId: rundownId,
	}, adlibPieces)

	// determine if update is allowed here
	if (!isUpdateAllowed(dbRundown, { changed: [{ doc: dbRundown, oldId: dbRundown._id }] }, prepareSaveSegments, prepareSaveParts)) {
		ServerRundownAPI.unsyncRundown(dbRundown._id)
		return false
	}

	changes = sumChanges(
		changes,
		// Save the baseline
		saveIntoDb<RundownBaselineObj, RundownBaselineObj>(RundownBaselineObjs, {
			rundownId: dbRundown._id,
		}, [baselineObj]),
		// Save the global adlibs
		saveIntoDb<RundownBaselineAdLibItem, RundownBaselineAdLibItem>(RundownBaselineAdLibPieces, {
			rundownId: dbRundown._id
		}, adlibItems),

		// Update Segments:
		savePreparedChanges(prepareSaveSegments, Segments, {
			afterInsert (segment) {
				logger.info('inserted segment ' + segment._id)
			},
			afterUpdate (segment) {
				logger.info('updated segment ' + segment._id)
			},
			afterRemove (segment) {
				logger.info('removed segment ' + segment._id)
			},
			afterRemoveAll (segments) {
				afterRemoveSegments(rundownId, _.map(segments, s => s._id))
			}
		}),

		savePreparedChanges<Part, DBPart>(prepareSaveParts, Parts, {
			afterInsert (part) {
				logger.debug('inserted part ' + part._id)
			},
			afterUpdate (part) {
				logger.debug('updated part ' + part._id)
			},
			afterRemove (part) {
				logger.debug('deleted part ' + part._id)
			},
			afterRemoveAll (parts) {
				afterRemoveParts(rundownId, parts)
			}
		}),

		savePreparedChanges<Piece, Piece>(prepareSavePieces, Pieces, {
			afterInsert (piece) {
				logger.debug('inserted piece ' + piece._id)
				logger.debug(piece)
			},
			afterUpdate (piece) {
				logger.debug('updated piece ' + piece._id)
			},
			afterRemove (piece) {
				logger.debug('deleted piece ' + piece._id)
			}
		}),

		savePreparedChanges<AdLibPiece, AdLibPiece>(prepareSaveAdLibPieces, AdLibPieces, {
			afterInsert (adLibPiece) {
				logger.debug('inserted adLibPiece ' + adLibPiece._id)
				logger.debug(adLibPiece)
			},
			afterUpdate (adLibPiece) {
				logger.debug('updated piece ' + adLibPiece._id)
			},
			afterRemove (adLibPiece) {
				logger.debug('deleted piece ' + adLibPiece._id)
			}
		})
	)

	const didChange = anythingChanged(changes)
	if (didChange) {
		afterIngestChangedData(dbRundown, _.map(segments, s => s._id))
	}

	logger.info(`Rundown ${dbRundown._id} update complete`)
	return didChange
}

function handleRemovedSegment (peripheralDevice: PeripheralDevice, rundownExternalId: string, segmentExternalId: string) {
	const studio = getStudioFromDevice(peripheralDevice)
	const rundownId = getRundownId(studio, rundownExternalId)

	return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => {
		const rundown = getRundown(rundownId, rundownExternalId)
		const segmentId = getSegmentId(rundown._id, segmentExternalId)

		const segment = Segments.findOne(segmentId)
		if (!segment) throw new Meteor.Error(404, `handleRemovedSegment: Segment "${segmentId}" not found`)

		if (canBeUpdated(rundown, segmentId)) {
			if (!isUpdateAllowed(rundown, {}, { removed: [segment] }, {})) {
				ServerRundownAPI.unsyncRundown(rundown._id)
			} else {
				if (removeSegments(rundownId, [segmentId]) === 0) {
					throw new Meteor.Error(404, `handleRemovedSegment: removeSegments: Segment ${segmentExternalId} not found`)
				}
			}
		}
	})
}
function handleUpdatedSegment (peripheralDevice: PeripheralDevice, rundownExternalId: string, ingestSegment: IngestSegment) {
	const studio = getStudioFromDevice(peripheralDevice)
	const rundownId = getRundownId(studio, rundownExternalId)

	return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => {
		const rundown = getRundown(rundownId, rundownExternalId)
		const segmentId = getSegmentId(rundown._id, ingestSegment.externalId)
		if (!canBeUpdated(rundown, segmentId)) return

		saveSegmentCache(rundown._id, segmentId, ingestSegment)
		const updatedSegmentId = updateSegmentFromIngestData(studio, rundown, ingestSegment)
		if (updatedSegmentId) {
			afterIngestChangedData(rundown, [updatedSegmentId])
		}
	})
}
export function updateSegmentsFromIngestData (
	studio: Studio,
	rundown: Rundown,
	ingestSegments: IngestSegment[]
) {
	const changedSegmentIds: string[] = []
	for (let ingestSegment of ingestSegments) {
		const segmentId = updateSegmentFromIngestData(studio, rundown, ingestSegment)
		if (segmentId !== null) {
			changedSegmentIds.push(segmentId)
		}
	}
	if (changedSegmentIds.length > 0) {
		afterIngestChangedData(rundown, changedSegmentIds)
	}
}
/**
 * Run ingestData through blueprints and update the Segment
 * @param studio
 * @param rundown
 * @param ingestSegment
 * @returns a segmentId if data has changed, null otherwise
 */
function updateSegmentFromIngestData (
	studio: Studio,
	rundown: Rundown,
	ingestSegment: IngestSegment
): string | null {
	const segmentId = getSegmentId(rundown._id, ingestSegment.externalId)
	const { blueprint, blueprintId } = getBlueprintOfRundown(rundown)

	const existingSegment = Segments.findOne({
		_id: segmentId,
		rundownId: rundown._id,
	})
	const existingParts = Parts.find({
		rundownId: rundown._id,
		segmentId: segmentId,
		dynamicallyInserted: { $ne: true }
	}).fetch()

	ingestSegment.parts = _.sortBy(ingestSegment.parts, s => s.rank)

	const context = new SegmentContext(rundown, studio, existingParts)
	context.handleNotesExternally = true
	const res = blueprint.getSegment(context, ingestSegment)

	const { parts, segmentPieces, adlibPieces, newSegment } = generateSegmentContents(context, blueprintId, ingestSegment, existingSegment, existingParts, res)

	waitForPromise(Promise.all([

		// Update segment info:
		asyncCollectionUpsert(Segments, {
			_id: segmentId,
			rundownId: rundown._id
		}, newSegment),

		// Move over parts from other segments:
		asyncCollectionUpdate(Parts, {
			rundownId: rundown._id,
			segmentId: { $ne: segmentId },
			dynamicallyInserted: { $ne: true },
			_id: { $in: _.pluck(parts, '_id') }
		}, { $set: {
			segmentId: segmentId
		}}, {
			multi: true
		})
	]))

	const prepareSaveParts = prepareSaveIntoDb<Part, DBPart>(Parts, {
		rundownId: rundown._id,
		segmentId: segmentId,
		dynamicallyInserted: { $ne: true } // do not affect dynamically inserted parts (such as adLib parts)
	}, parts)
	const prepareSavePieces = prepareSaveIntoDb<Piece, Piece>(Pieces, {
		rundownId: rundown._id,
		partId: { $in: parts.map(p => p._id) },
		dynamicallyInserted: { $ne: true } // do not affect dynamically inserted pieces (such as adLib pieces)
	}, segmentPieces)
	const prepareSaveAdLibPieces = prepareSaveIntoDb<AdLibPiece, AdLibPiece>(AdLibPieces, {
		rundownId: rundown._id,
		partId: { $in: parts.map(p => p._id) },
	}, adlibPieces)

	// determine if update is allowed here
	if (!isUpdateAllowed(rundown, {}, { changed: [{ doc: newSegment, oldId: newSegment._id }] }, prepareSaveParts)) {
		ServerRundownAPI.unsyncRundown(rundown._id)
		return null
	}

	const changes = sumChanges(
		savePreparedChanges<Part, DBPart>(prepareSaveParts, Parts, {
			afterInsert (part) {
				logger.debug('inserted part ' + part._id)
			},
			afterUpdate (part) {
				logger.debug('updated part ' + part._id)
			},
			afterRemove (part) {
				logger.debug('deleted part ' + part._id)
			},
			afterRemoveAll (parts) {
				afterRemoveParts(rundown._id, parts)
			}
		}),
		savePreparedChanges<Piece, Piece>(prepareSavePieces, Pieces, {
			afterInsert (piece) {
				logger.debug('inserted piece ' + piece._id)
				logger.debug(piece)
			},
			afterUpdate (piece) {
				logger.debug('updated piece ' + piece._id)
			},
			afterRemove (piece) {
				logger.debug('deleted piece ' + piece._id)
			}
		}),
		savePreparedChanges<AdLibPiece, AdLibPiece>(prepareSaveAdLibPieces, AdLibPieces, {
			afterInsert (adLibPiece) {
				logger.debug('inserted adLibPiece ' + adLibPiece._id)
				logger.debug(adLibPiece)
			},
			afterUpdate (adLibPiece) {
				logger.debug('updated adLibPiece ' + adLibPiece._id)
			},
			afterRemove (adLibPiece) {
				logger.debug('deleted adLibPiece ' + adLibPiece._id)
			}
		})
	)
	return anythingChanged(changes) ? segmentId : null
}
export function afterIngestChangedData (rundown: Rundown, segmentIds: string[]) {
	// To be called after rundown has been changed
	updateExpectedMediaItemsOnRundown(rundown._id)
	updateExpectedPlayoutItemsOnRundown(rundown._id)
	updatePartRanks(rundown._id)
	updateSourceLayerInfinitesAfterPart(rundown)
	UpdateNext.ensureNextPartIsValid(rundown)
	triggerUpdateTimelineAfterIngestData(rundown._id, segmentIds)
}

export function handleRemovedPart (peripheralDevice: PeripheralDevice, rundownExternalId: string, segmentExternalId: string, partExternalId: string) {
	const studio = getStudioFromDevice(peripheralDevice)
	const rundownId = getRundownId(studio, rundownExternalId)

	return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => {
		const rundown = getRundown(rundownId, rundownExternalId)
		const segmentId = getSegmentId(rundown._id, segmentExternalId)
		const partId = getPartId(rundown._id, partExternalId)


		if (canBeUpdated(rundown, segmentId, partId)) {
			const part = Parts.findOne({
				_id: partId,
				segmentId: segmentId,
				rundownId: rundown._id
			})
			if (!part) throw new Meteor.Error(404, 'Part not found')

			if (!isUpdateAllowed(rundown, {}, {}, { removed: [part] })) {
				ServerRundownAPI.unsyncRundown(rundown._id)
			} else {

				// Blueprints will handle the deletion of the Part
				const ingestSegment = loadCachedIngestSegment(rundown._id, rundownExternalId, segmentId, segmentExternalId)
				ingestSegment.parts = ingestSegment.parts.filter(p => p.externalId !== partExternalId)

				saveSegmentCache(rundown._id, segmentId, ingestSegment)

				const updatedSegmentId = updateSegmentFromIngestData(studio, rundown, ingestSegment)
				if (updatedSegmentId) {
					afterIngestChangedData(rundown, [updatedSegmentId])
				}
			}
		}


	})
}
export function handleUpdatedPart (peripheralDevice: PeripheralDevice, rundownExternalId: string, segmentExternalId: string, ingestPart: IngestPart) {
	const studio = getStudioFromDevice(peripheralDevice)
	const rundownId = getRundownId(studio, rundownExternalId)

	return rundownSyncFunction(rundownId, RundownSyncFunctionPriority.Ingest, () => {
		const rundown = getRundown(rundownId, rundownExternalId)

		handleUpdatedPartInner(studio, rundown, segmentExternalId, ingestPart)
	})
}
export function handleUpdatedPartInner (studio: Studio, rundown: Rundown, segmentExternalId: string, ingestPart: IngestPart) {
	// Updated OR created part
	const segmentId = getSegmentId(rundown._id, segmentExternalId)
	const partId = getPartId(rundown._id, ingestPart.externalId)

	if (!canBeUpdated(rundown, segmentId, partId)) return

	const part = Parts.findOne({
		_id: partId,
		segmentId: segmentId,
		rundownId: rundown._id
	})

	if (
		part && !isUpdateAllowed(rundown, {}, {}, { changed: [{ doc: part, oldId: part._id }] })) {
		ServerRundownAPI.unsyncRundown(rundown._id)
	} else {

		// Blueprints will handle the creation of the Part
		const ingestSegment: IngestSegment = loadCachedIngestSegment(rundown._id, rundown.externalId, segmentId, segmentExternalId)
		ingestSegment.parts = ingestSegment.parts.filter(p => p.externalId !== ingestPart.externalId)
		ingestSegment.parts.push(ingestPart)

		saveSegmentCache(rundown._id, segmentId, ingestSegment)
		const updatedSegmentId = updateSegmentFromIngestData(studio, rundown, ingestSegment)
		if (updatedSegmentId) {
			afterIngestChangedData(rundown, [updatedSegmentId])
		}
	}
}

function generateSegmentContents (
	context: RundownContext,
	blueprintId: string,
	ingestSegment: IngestSegment,
	existingSegment: DBSegment | undefined,
	existingParts: DBPart[],
	blueprintRes: BlueprintResultSegment
) {
	const rundownId = context.rundownId
	const segmentId = getSegmentId(rundownId, ingestSegment.externalId)

	const allNotes = _.map(context.getNotes(), note => literal<PartNote>({
		...note,
		origin: {
			name: note.origin.name,
			rundownId: rundownId,
			segmentId: segmentId,
			partId: note.origin.partId,
			pieceId: note.origin.pieceId,
		}
	}))

	// Ensure all parts have a valid externalId set on them
	const knownPartIds = blueprintRes.parts.map(p => p.part.externalId)

	const segmentNotes = _.filter(allNotes, note => !note.origin.partId || knownPartIds.indexOf(note.origin.partId) === -1)

	const newSegment = literal<DBSegment>({
		...(existingSegment || {}),
		...blueprintRes.segment,
		_id: segmentId,
		rundownId: rundownId,
		externalId: ingestSegment.externalId,
		_rank: ingestSegment.rank,
		notes: segmentNotes,
	})

	const parts: DBPart[] = []
	const segmentPieces: Piece[] = []
	const adlibPieces: AdLibPiece[] = []

	// Parts
	blueprintRes.parts.forEach((blueprintPart, i) => {
		const partId = getPartId(rundownId, blueprintPart.part.externalId)

		const notes = _.filter(allNotes, note => note.origin.partId === blueprintPart.part.externalId)
		_.each(notes, note => note.origin.partId = partId)

		const existingPart = _.find(existingParts, p => p._id === partId)
		const part = literal<DBPart>({
			..._.omit(existingPart || {}, 'invalid'),
			...blueprintPart.part,
			_id: partId,
			rundownId: rundownId,
			segmentId: newSegment._id,
			_rank: i, // This gets updated to a rundown unique rank as a later step
			notes: notes,
		})
		parts.push(part)

		// Update pieces
		const pieces = postProcessPieces(context, blueprintPart.pieces, blueprintId, part._id)
		segmentPieces.push(...pieces)

		const adlibs = postProcessAdLibPieces(context, blueprintPart.adLibPieces, blueprintId, part._id)
		adlibPieces.push(...adlibs)
	})

	return {
		newSegment,
		parts,
		segmentPieces,
		adlibPieces
	}
}

export function isUpdateAllowed (
	rundown: Rundown,
	rundownChanges: Optional<PreparedChanges<DBRundown>>,
	segmentChanges: Optional<PreparedChanges<DBSegment>>,
	partChanges: Optional<PreparedChanges<DBPart>>
): boolean {
	let allowed: boolean = true

	if (!rundown) return false
	if (rundown.unsynced) {
		logger.info(`Rundown "${rundown._id}" has been unsynced and needs to be synced before it can be updated.`)
		return false
	}

	if (rundown.active) {

		if (allowed && rundownChanges.removed && rundownChanges.removed.length) {
			_.each(rundownChanges.removed, rd => {
				if (rundown._id === rd._id) {
					// Don't allow removing an active rundown
					logger.warn(`Not allowing removal of current active rundown "${rd._id}", making rundown unsynced instead`)
					allowed = false
				}
			})
		}
		if (rundown.currentPartId) {
			if (allowed && partChanges.removed && partChanges.removed.length) {
				_.each(partChanges.removed, part => {
					if (rundown.currentPartId === part._id) {
						// Don't allow removing currently playing part
						logger.warn(`Not allowing removal of currently playing part "${part._id}", making rundown unsynced instead`)
						allowed = false
					}
				})
			}
			if (allowed && segmentChanges.removed && segmentChanges.removed.length) {
				const currentPart = rundown.getParts({ _id: rundown.currentPartId })[0]
				_.each(segmentChanges.removed, segment => {
					if (currentPart.segmentId === segment._id) {
						// Don't allow removing segment with currently playing part
						logger.warn(`Not allowing removal of segment "${segment._id}", containing currently playing part "${currentPart._id}", making rundown unsynced instead`)
						allowed = false
					}
				})
			}
		}
	}
	if (!allowed) {
		logger.debug(`rundownChanges: ${printChanges(rundownChanges)}`)
		logger.debug(`segmentChanges: ${printChanges(segmentChanges)}`)
		logger.debug(`partChanges: ${printChanges(partChanges)}`)
	}
	return allowed
}
function printChanges (changes: Optional<PreparedChanges<{_id: string}>>): string {
	let str = ''

	if (changes.changed)	str += _.map(changes.changed,	doc => 'change:' + doc.doc._id).join(',')
	if (changes.inserted)	str += _.map(changes.inserted,	doc => 'insert:' + doc._id).join(',')
	if (changes.removed)	str += _.map(changes.removed,	doc => 'remove:' + doc._id).join(',')

	return str
}
