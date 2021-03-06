import * as React from 'react'
import * as _ from 'underscore'
import { Translated } from '../lib/ReactMeteorData/ReactMeteorData'
import { Rundown } from '../../lib/collections/Rundowns'
import { translate } from 'react-i18next'
import { EditAttribute } from '../lib/EditAttribute'
import { EvaluationBase } from '../../lib/collections/Evaluations'
import { doUserAction } from '../lib/userAction'
import { UserActionAPI } from '../../lib/api/userActions'

interface IProps {
	rundown: Rundown
}
interface IState {
	q0: string
	q1: string
	q2: string
}
// export default translate()(class Dashboard extends React.Component<Translated<IProps>, IState> {
export const AfterBroadcastForm = translate()(class AfterBroadcastForm extends React.Component<Translated<IProps>, IState> {

	constructor (props: Translated<IProps>) {
		super(props)
		this.state = {
			q0: 'nothing',
			q1: '',
			q2: '',
		}
	}
	saveForm = (e: React.MouseEvent<HTMLElement>) => {
		const { t } = this.props
		let answers = this.state

		const saveEvaluation = (snapshotId?: string) => {
			let evaluation: EvaluationBase = {
				studioId: this.props.rundown.studioId,
				rundownId: this.props.rundown._id,
				answers: answers
			}
			if (snapshotId && evaluation.snapshots) evaluation.snapshots.push(snapshotId)

			doUserAction(t, e, UserActionAPI.methods.saveEvaluation, [evaluation])

			doUserAction(t, e, UserActionAPI.methods.deactivate, [this.props.rundown._id])

			this.setState({
				q0: '',
				q1: '',
				q2: '',
			})
		}

		if (answers.q0 !== 'nothing') {
			doUserAction(t, e, UserActionAPI.methods.storeRundownSnapshot, [this.props.rundown._id, 'Evaluation form'], (err, response) => {
				if (!err && response) {
					saveEvaluation(response.result)
				} else {
					saveEvaluation()
				}
			})
		} else {
			saveEvaluation()
		}
	}
	onUpdateValue = (edit: any, newValue: any) => {
		let attr = edit.props.attribute

		if (attr) {
			let m = {}
			m[attr] = newValue
			this.setState(m)
		}
	}
	render () {
		const { t } = this.props

		let obj = this.state
		// console.log('obj', obj)
		return (
			<div className='afterbroadcastform-container'>
				<div className='afterbroadcastform'>

					<h2>{t('Evaluation')}</h2>

					<p><em>{t('Please take a minute to fill in this form.')}</em></p>

					<div className='form'>
						<div className='question'>
							<p>{t('Did you have any problems with the broadcast?')}</p>
							<div className='input q0'>
								<EditAttribute
									obj={obj}
									updateFunction={this.onUpdateValue}
									attribute='q0'
									type='dropdown'
									options={getQuestionOptions(t)}
								/>
							</div>
						</div>
						<div className='question q1'>
							<p>{t('Please explain the problems you experienced (what happened and when, what should have happened, what could have triggered the problems, etcetera...)')}</p>
							<div className='input'>
								<EditAttribute
									obj={obj}
									updateFunction={this.onUpdateValue}
									attribute='q1'
									type='multiline'
								/>
							</div>
						</div>
						<div className='question q2'>
							<p>{t('Your name')}</p>
							<div className='input'>
								<EditAttribute
									obj={obj}
									updateFunction={this.onUpdateValue}
									attribute='q2'
									type='text'
								/>
							</div>
						</div>

						<button className='btn btn-primary' onClick={this.saveForm}>
							{t('Save message and Deactivate Rundown')}
						</button>
					</div>
				</div>
			</div>
		)
	}
})
export function getQuestionOptions (t) {
	return [
		{ value: 'nothing', name: t('No problems') },
		{ value: 'minor', name: t('Something went wrong, but it didn\'t affect the output') },
		{ value: 'major', name: t('Something went wrong, and it affected the output') },
	]
}
