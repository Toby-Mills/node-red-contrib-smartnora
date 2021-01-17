import {
    BrightnessDevice, BrightnessState, ColorSettingDevice, ColorSettingState,
    Device, isBrightness, isColorSetting, OnOffDevice, OnOffState
} from '@andrei-tatar/nora-firebase-common';
import { Subject } from 'rxjs';
import { first, publishReplay, refCount, skip, switchMap, takeUntil, tap } from 'rxjs/operators';
import { NodeInterface } from '..';
import { FirebaseConnection } from '../firebase/connection';
import { convertValueType, getId, getValue, R } from './util';

module.exports = function (RED: any) {
    RED.nodes.registerType('noraf-light', function (this: NodeInterface, config: any) {
        RED.nodes.createNode(this, config);

        const noraConfig = RED.nodes.getNode(config.nora);
        if (!noraConfig?.valid) { return; }

        const brightnessControl = !!config.brightnesscontrol;
        const statepayload = !!config.statepayload;
        const colorControl = !!config.lightcolor;
        const turnOnWhenBrightnessChanges = !!config.turnonwhenbrightnesschanges;
        const { value: onValue, type: onType } = convertValueType(RED, config.onvalue, config.onvalueType, { defaultValue: true });
        const { value: offValue, type: offType } = convertValueType(RED, config.offvalue, config.offvalueType, { defaultValue: false });
        const brightnessOverride = Math.max(0, Math.min(100, Math.round(config.brightnessoverride))) || 0;

        const close$ = new Subject();

        const deviceConfig: Device = {
            id: getId(config),
            type: 'action.devices.types.LIGHT',
            traits: ['action.devices.traits.OnOff'],
            name: {
                name: config.devicename,
            },
            roomHint: config.roomhint,
            willReportState: true,
            state: {
                online: true,
                on: false,
            },
            attributes: {
            },
        };

        if (brightnessControl) {
            deviceConfig.traits.push('action.devices.traits.Brightness');
            if (isBrightness(deviceConfig)) {
                deviceConfig.state.brightness = 100;
                deviceConfig.noraSpecific = {
                    turnOnWhenBrightnessChanges,
                };
            }
        }
        if (colorControl) {
            deviceConfig.traits.push('action.devices.traits.ColorSetting');
            if (isColorSetting(deviceConfig)) {
                deviceConfig.attributes = {
                    colorModel: 'hsv',
                };
                deviceConfig.state.color = {
                    spectrumHsv: {
                        hue: 0,
                        saturation: 0,
                        value: 1,
                    },
                };
            }
        }
        const stateString$ = new Subject<string>();

        const device$ = FirebaseConnection
            .fromConfig(noraConfig, this, stateString$)
            .pipe(
                switchMap(connection => connection.createDevice<OnOffDevice & ColorSettingDevice & BrightnessDevice>(deviceConfig as any)),
                publishReplay(1),
                refCount(),
                takeUntil(close$),
            );

        device$.pipe(
            switchMap(d => d.state$),
            tap(state => notifyState(state)),
            skip(1),
            takeUntil(close$),
        ).subscribe((state) => {
            if (!brightnessControl) {
                const value = state.on;
                this.send({
                    payload: getValue(RED, this, value ? onValue : offValue, value ? onType : offType),
                    topic: config.topic
                });
            } else {
                if (statepayload) {
                    this.send({
                        payload: { ...state },
                        topic: config.topic
                    });
                } else {
                    this.send({
                        payload: state.on && 'brightness' in state ? state.brightness : 0,
                        topic: config.topic
                    });
                }
            }
        });

        this.on('input', async msg => {
            if (config.passthru) {
                this.send(msg);
            }

            const device = await device$.pipe(first()).toPromise();
            if (!brightnessControl) {
                const myOnValue = getValue(RED, this, onValue, onType);
                const myOffValue = getValue(RED, this, offValue, offType);
                if (RED.util.compareObjects(myOnValue, msg.payload)) {
                    await device.updateState({ on: true });
                } else if (RED.util.compareObjects(myOffValue, msg.payload)) {
                    await device.updateState({ on: false });
                }
            } else {
                if (!await device.updateStateSafer(msg?.payload)) {
                    const brightness = Math.max(0, Math.min(100, Math.round(msg.payload)));

                    if (isFinite(brightness)) {
                        if (brightness === 0) {
                            if (brightnessOverride !== 0) {
                                await device.updateState({
                                    on: false,
                                    brightness: brightnessOverride,
                                });
                            } else {
                                await device.updateState({
                                    on: false,
                                });
                            }
                        } else {
                            await device.updateState({
                                on: true,
                                brightness: brightness,
                            });
                        }
                    } else {
                        this.error('Payload must be a number in range 0-100');
                    }
                }
            }
        });

        this.on('close', () => {
            close$.next();
            close$.complete();
        });

        function notifyState(state: OnOffState & BrightnessState & ColorSettingState) {
            let stateString = state.on ? 'on' : 'off';
            if (brightnessControl && 'brightness' in state) {
                stateString += ` ${state.brightness}`;
            }
            if (colorControl && 'color' in state && 'spectrumHsv' in state.color) {
                stateString += R` hue: ${state.color.spectrumHsv.hue}°`;
                stateString += R` sat: ${Number(state.color.spectrumHsv.saturation * 100)}%`;
                stateString += R` val: ${Number(state.color.spectrumHsv.value * 100)}%`;
            }

            stateString$.next(`(${stateString})`);
        }
    });
};
