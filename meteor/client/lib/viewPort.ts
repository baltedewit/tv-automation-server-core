import * as _ from 'underscore'
import * as Velocity from 'velocity-animate'

import { SEGMENT_TIMELINE_ELEMENT_ID } from '../ui/SegmentTimeline/SegmentTimeline'
import { Parts } from '../../lib/collections/Parts'

let focusInterval: NodeJS.Timer | undefined
let _dontClearInterval: boolean = false

export function maintainFocusOnPart (partId: string, timeWindow: number, forceScroll?: boolean, noAnimation?: boolean) {
	let startTime = Date.now()
	const focus = () => {
		// console.log("focus");
		if (Date.now() - startTime < timeWindow) {
			_dontClearInterval = true
			scrollToPart(partId, forceScroll, noAnimation).then(() => {
				_dontClearInterval = false
			}).catch(() => {
				_dontClearInterval = false
			})
		} else {
			quitFocusOnPart()
		}
	}
	focusInterval = setInterval(focus, 500)
	focus()
}

export function isMaintainingFocus (): boolean {
	return !!focusInterval
}

function quitFocusOnPart () {
	if (!_dontClearInterval && focusInterval) {
		// console.log("quitFocusOnPart")
		clearInterval(focusInterval)
		focusInterval = undefined
	}
}

export function scrollToPart (partId: string, forceScroll?: boolean, noAnimation?: boolean): Promise<boolean> {
	// TODO: do scrolling within segment as well?
	quitFocusOnPart()
	let part = Parts.findOne(partId)
	if (part) {
		return scrollToSegment(part.segmentId, forceScroll, noAnimation)
	}
	return Promise.reject('Could not find part')
}

export const HEADER_HEIGHT = 54 // was: 150
export const HEADER_MARGIN = 15

export function scrollToSegment (elementToScrollToOrSegmentId: HTMLElement | string, forceScroll?: boolean, noAnimation?: boolean): Promise<boolean> {
	let elementToScrollTo: HTMLElement | null = (
		_.isString(elementToScrollToOrSegmentId) ?
			document.querySelector('#' + SEGMENT_TIMELINE_ELEMENT_ID + elementToScrollToOrSegmentId) :
			elementToScrollToOrSegmentId
	)

	if (!elementToScrollTo) {
		return Promise.reject('Could not find segment element')
	}

	let { top, bottom } = elementToScrollTo.getBoundingClientRect()
	top += window.scrollY
	bottom += window.scrollY

	// check if the item is in viewport
	if (forceScroll ||
		bottom > window.scrollY + window.innerHeight ||
		top < window.scrollY + HEADER_HEIGHT + HEADER_MARGIN) {

		return scrollToPosition(top, noAnimation).then(() => true)
	}

	return Promise.resolve(false)
}

export function scrollToPosition (scrollPosition: number, noAnimation?: boolean): Promise<void> {
	if (noAnimation) {
		return new Promise((resolve, reject) => {
			window.scroll({
				top: Math.max(0, scrollPosition - HEADER_HEIGHT - HEADER_MARGIN),
				left: 0
			})
			resolve()
		})
	} else {
		return new Promise((resolve, reject) => {
			window.requestIdleCallback(() => {
				window.scroll({
					top: Math.max(0, scrollPosition - HEADER_HEIGHT - HEADER_MARGIN),
					left: 0,
					behavior: 'smooth'
				})
				resolve()
			}, { timeout: 250 })
		})
	}
}
