import {AfterViewInit, Component, ElementRef, OnDestroy, OnInit} from '@angular/core';
import {DiskImage} from "../../emulator/classes/diskimage";
import {TI994A} from "../../emulator/classes/ti994a";
import {Subscription} from "rxjs";
import {Log} from "../../classes/log";
import {ActivatedRoute, ParamMap} from "@angular/router";
import {AudioService} from "../../services/audio.service";
import {CommandDispatcherService} from "../../services/command-dispatcher.service";
import {EventDispatcherService} from "../../services/event-dispatcher.service";
import {SettingsService} from "../../services/settings.service";
import {DiskService} from "../../services/disk.service";
import {DatabaseService} from "../../services/database.service";
import {ModuleService} from "../../services/module.service";
import {MoreSoftwareService} from "../../services/more-software.service";
import * as $ from "jquery";
import { MatTabChangeEvent } from "@angular/material/tabs";
import {Command, CommandType} from "../../classes/command";
import {Setting, Settings} from "../../classes/settings";
import {ConsoleEvent, ConsoleEventType} from "../../classes/consoleevent";
import {Software} from "../../classes/software";
import "rxjs-compat/add/operator/map";
import "rxjs-compat/add/operator/mergeMap";
import {AppComponent} from "../../app.component";

@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrls: ['./main.component.css']
})
export class MainComponent implements OnInit, AfterViewInit, OnDestroy {

    diskImages: DiskImage[];
    ti994A: TI994A;
    tabIndex: number;

    title = AppComponent.TITLE;
    version = AppComponent.VERSION;
    date = AppComponent.DATE;

    private cartName = "extended_basic";
    private started = false;
    private autoRun = false;
    private wasRunning = false;
    private routerSubscription: Subscription;
    private commandSubscription: Subscription;
    private eventSubscription: Subscription;
    private log: Log = Log.getLog();

    constructor(
        private element: ElementRef,
        private route: ActivatedRoute,
        private audioService: AudioService,
        private commandDispatcherService: CommandDispatcherService,
        private eventDispatcherService: EventDispatcherService,
        private settingsService: SettingsService,
        private diskService: DiskService,
        private databaseService: DatabaseService,
        private moduleService: ModuleService,
        private moreSoftwareService: MoreSoftwareService
    ) {}

    ngOnInit() {
        this.diskImages = this.diskService.createDefaultDiskImages();
        this.commandSubscription = this.commandDispatcherService.subscribe(this.onCommand.bind(this));
        this.eventSubscription = this.eventDispatcherService.subscribe(this.onEvent.bind(this));
        this.route.paramMap.subscribe(this.onParametersChanged.bind(this));
        this.log.info("Welcome to " + AppComponent.TITLE + " version " + AppComponent.VERSION);
        this.log.info("--------------------------------");
    }

    ngAfterViewInit(): void {
        $(this.element.nativeElement).one("click keydown touchstart", function () {
            AudioService.resumeSound();
        });
        $(window).on("blur", () => {
            if (this.settingsService.isPauseOnFocusLostEnabled()) {
                this.wasRunning = this.ti994A.isRunning();
                if (this.wasRunning) {
                    this.commandDispatcherService.stop();
                }
            }
        });
        $(window).on("focus", () => {
            if (this.settingsService.isPauseOnFocusLostEnabled()) {
                if (this.wasRunning) {
                    this.commandDispatcherService.start();
                }
            }
        });
    }

    onParametersChanged(params: ParamMap) {
        const cartName = params.get('cart');
        if (cartName) {
            this.autoRun = true;
            if (this.started) {
                this.loadCartridge(cartName);
            } else {
                this.cartName = cartName;
            }
        }
    }

    onTabSelected(event: MatTabChangeEvent) {
        this.tabIndex = event.index;
    }

    onCommand(command: Command) {
        this.log.info(command.type);
        switch (command.type) {
            case CommandType.CHANGE_SETTING:
                const setting: Setting = command.data.setting;
                if (setting === Setting.SOUND) {
                    const value: boolean = command.data.value;
                    this.audioService.setSoundEnabled(value);
                }
                break;
            case CommandType.SAVE_STATE:
                this.saveState();
                break;
            case CommandType.RESTORE_STATE:
                this.restoreState();
                break;
        }
    }

    onEvent(event: ConsoleEvent) {
        this.log.info(event.type);
        switch (event.type) {
            case ConsoleEventType.READY:
                this.ti994A = event.data;
                this.audioService.init(this.settingsService.isSoundEnabled(), this.ti994A.getPSG(), this.ti994A.getSpeech(), this.ti994A.getTape());
                this.loadCartridge(this.cartName);
                this.commandDispatcherService.start();
                break;
            case ConsoleEventType.STARTED:
                if (this.autoRun) {
                    window.setTimeout(
                        () => {
                            this.ti994A.getKeyboard().simulateKeyPresses(" 2", null);
                        },
                        2000
                    );
                    this.autoRun = false;
                }
                break;
        }
    }

    loadCartridge(cartName: string) {
        this.log.info("Load cart: " + cartName);
        this.moreSoftwareService.getByName(cartName.replace(/_/g, ' ')).subscribe(
            (cart: Software) => {
                this.moduleService.loadRPKModuleFromURL("assets/" + cart.url).subscribe(
                    (software: Software) => {
                        this.commandDispatcherService.loadSoftware(software);
                    },
                    (error) => {
                        this.log.error(error + " " + cart.url);
                    }
                );
            },
            (error) => {
                this.log.error(error);
            }
        );
    }

    saveState() {
        const that = this;
        const database = this.databaseService;
        if (database.isSupported()) {
            database.deleteAllDiskImages().map(
                () => that.diskService.saveDiskImages(that.diskImages)
            ).map(
                () => {
                    that.log.info('Disk images saved OK.');
                    const diskDrives = that.ti994A.getDiskDrives();
                    return that.diskService.saveDiskDrives(diskDrives);
                }
            ).mergeMap(
                () => {
                    that.log.info('Disk drives saved OK.');
                    const state = that.ti994A.getState();
                    return database.putMachineState('ti994a', state);
                }
            ).subscribe(
                () => {
                    this.log.info("Machine state saved OK.");
                },
                that.log.error
            );
        }
    }

    restoreState() {
        const that = this;
        const database = this.databaseService;
        const wasRunning = this.ti994A.isRunning();
        if (wasRunning) {
            this.commandDispatcherService.stop();
        }
        database.getDiskImages().map(
            (diskImages: DiskImage[]) => {
                that.diskImages = diskImages;
                that.log.info("Disk images restored OK.");
                const diskDrives = that.ti994A.getDiskDrives();
                return that.diskService.restoreDiskDrives(diskDrives, diskImages);
            }
        ).mergeMap(
            () => {
                that.log.info("Disk drives restored OK.");
                return database.getMachineState("ti994a");
            }
        ).subscribe(
            (state: any) => {
                const f18AEnabled = typeof(state.vdp.gpu) === "object";
                if (f18AEnabled && !that.settingsService.isF18AEnabled()) {
                    that.log.error("Please enable F18A before restoring the state");
                    return;
                } else if (!f18AEnabled && that.settingsService.isF18AEnabled()) {
                    that.log.error("Please disable F18A before restoring the state");
                    return;
                }

                that.ti994A.restoreState(state);
                that.log.info("Console state restored");

                const settings: Settings = new Settings();
                settings.setSoundEnabled(that.settingsService.isSoundEnabled());
                settings.setSpeechEnabled(state.speech.enabled);
                settings.set32KRAMEnabled(state.memory.enable32KRAM);
                settings.setF18AEnabled(that.settingsService.isF18AEnabled());
                settings.setFlickerEnabled(state.vdp.enableFlicker);
                settings.setPCKeyboardEnabled(state.keyboard.pcKeyboardEnabled);
                settings.setMapArrowKeysEnabled(state.keyboard.mapArrowKeysToFctnSDEX);
                settings.setGoogleDriveEnabled(that.settingsService.isGoogleDriveEnabled());
                settings.setAMSEnabled(state.memory.enableAMS);
                settings.setGRAMEnabled(state.memory.enableGRAM);
                settings.setPixelatedEnabled(that.settingsService.isPixelatedEnabled());
                that.settingsService.restoreSettings(settings);

                if (state.tape.recordPressed) {
                    that.eventDispatcherService.tapeRecording();
                } else if (state.tape.playPressed) {
                    that.eventDispatcherService.tapePlaying();
                } else {
                    const tape = that.ti994A.getTape();
                    that.eventDispatcherService.tapeStopped(tape.isPlayEnabled(), tape.isRewindEnabled());
                }

                that.commandDispatcherService.setBreakpointAddress(state.cpu.breakpoint);

                if (wasRunning) {
                    that.commandDispatcherService.start();
                } else {
                    that.ti994A.getPSG().mute();
                }

                that.eventDispatcherService.stateRestored();

                that.log.info("Machine state restored OK.");
            },
            that.log.error
        );
    }

    ngOnDestroy() {
        if (this.routerSubscription) {
            this.routerSubscription.unsubscribe();
        }
        if (this.commandSubscription) {
            this.commandSubscription.unsubscribe();
        }
        if (this.eventSubscription) {
            this.eventSubscription.unsubscribe();
        }
    }

}
