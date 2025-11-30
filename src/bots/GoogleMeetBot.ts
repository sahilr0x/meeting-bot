import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleUnsupportedMeetingError, handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { GOOGLE_LOBBY_MODE_HOST_TEXT, GOOGLE_REQUEST_DENIED, GOOGLE_REQUEST_TIMEOUT } from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';
import { TtsService } from '../services/ttsService';
import { OpenAIService } from '../services/openaiService';
import { SttService } from '../services/sttService';

export class GoogleMeetBot extends MeetBotBase {
  private _logger: Logger;
  private _correlationId: string;
  private _openAI: OpenAIService | null = null;
  private _sttService: SttService | null = null;
  
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
    this._correlationId = correlationId;
    
    // Initialize OpenAI service with HR onboarding prompt
    try {
      // Use default prompt from OpenAIService (it's already set to be conversational)
      this._openAI = new OpenAIService(this._logger);
      this._logger.info('OpenAI service initialized successfully');
    } catch (error: any) {
      this._logger.warn('Failed to initialize OpenAI service', { error: error?.message });
      this._logger.warn('Voice-activated responses will use fallback messages');
      this._openAI = null;
    }
    
    // Initialize STT service for remote audio transcription
    try {
      this._sttService = new SttService(this._logger);
      this._logger.info('STT service initialized successfully');
    } catch (error: any) {
      this._logger.warn('Failed to initialize STT service', { error: error?.message });
      this._sttService = null;
    }
  }


  private async findAndOptionallyClickElement(
    page: any,
    xpath: string,
    logger: Logger,
    shouldClick: boolean = true
  ): Promise<boolean> {
    try {
      const element = page.locator(`xpath=${xpath}`);
      const count = await element.count();
      
      if (count === 0) {
        logger.info(`Element not found: ${xpath}`);
        return false;
      }

      const isVisible = await element.isVisible({ timeout: 5000 }).catch(() => false);
      if (!isVisible) {
        logger.info(`Element found but not visible: ${xpath}`);
        return false;
      }

      if (shouldClick) {
        await element.click();
        await page.waitForTimeout(500);
        logger.info(`Successfully clicked element: ${xpath}`);
      }

      return true;
    } catch (err: any) {
      logger.info(`Could not find/click element: ${xpath}`, { error: err?.message });
      return false;
    }
  }

  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, pushState });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
      }

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      // Cleanup Deepgram connection on error
      if (this._deepgramConnectionId && this._sttService) {
        try {
          this._sttService.closeLiveConnection(this._deepgramConnectionId);
          this._logger.info('Closed Deepgram real-time connection on error', { connectionId: this._deepgramConnectionId });
        } catch (cleanupError: any) {
          this._logger.warn('Error closing Deepgram connection on error', { error: cleanupError?.message });
        }
      }

      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      if (error instanceof UnsupportedMeetingError) {
        await handleUnsupportedMeetingError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      throw error;
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');

    this.page = await createBrowserContext(url, this._correlationId, 'google');

    // Override getUserMedia early to intercept Google Meet's audio requests
    // Also hook into RTCPeerConnection creation to capture instances
    await this.page.addInitScript(() => {
      // Store the original getUserMedia
      const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      
      // Override getUserMedia to intercept audio requests
      navigator.mediaDevices.getUserMedia = async function(constraints: MediaStreamConstraints) {
        // Check if there's a TTS stream available
        const ttsStream = (window as any).__ttsAudioStream;
        
        if (ttsStream && constraints.audio) {
          console.log('[TTS] Intercepted getUserMedia call, returning TTS stream');
          return Promise.resolve(ttsStream);
        }
        // For video or when TTS stream is not available, use original
        return originalGetUserMedia(constraints);
      };
      
      // Hook into RTCPeerConnection constructor to capture all instances
      const OriginalRTCPeerConnection = window.RTCPeerConnection;
      const peerConnections: RTCPeerConnection[] = [];
      
      (window as any).RTCPeerConnection = function(...args: any[]) {
        const pc = new OriginalRTCPeerConnection(...args);
        peerConnections.push(pc);
        (window as any).__googleMeetPeerConnections = peerConnections;
        console.log('[TTS] RTCPeerConnection created, total:', peerConnections.length);
        return pc;
      };
      
      // Copy static methods
      (window as any).RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
      Object.setPrototypeOf((window as any).RTCPeerConnection, OriginalRTCPeerConnection);
      
      console.log('[TTS] getUserMedia override and RTCPeerConnection hook installed');
    });

    this._logger.info('Navigating to Google Meet URL...');
    await this.page.goto(url, { waitUntil: 'networkidle' });

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    const dismissDeviceCheck = async () => {
      try {
        this._logger.info('Clicking Continue without microphone and camera button...');
        await retryActionWithWait(
          'Clicking the "Continue without microphone and camera" button',
          async () => {
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).waitFor({ timeout: 30000 });
            await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).click();
          },
          this._logger,
          1,
          15000,
        );
      } catch (dismissError) {
        this._logger.info('Continue without microphone and camera button is probably missing!...');
      }
    };

    await dismissDeviceCheck();

    const verifyItIsOnGoogleMeetPage = async (): Promise<'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null> => {
      try {
        const detectSignInPage = async () => {
          let result = false;
          const url = await this.page.url();
          if (url.startsWith('https://accounts.google.com/')) {
            this._logger.info('Google Meet bot is on the sign in page...', { userId, teamId });
            result = true;
          }
          const signInPage = await this.page.locator('h1', { hasText: 'Sign in' });
          if (await signInPage.count() > 0 && await signInPage.isVisible()) {
            this._logger.info('Google Meet bot is on the page with "Sign in" heading...', { userId, teamId });
            result = result && true;
          }
          return result;
        };
        const pageUrl = await this.page.url();
        if (!pageUrl.includes('meet.google.com')) {
          const signInPage = await detectSignInPage();
          return signInPage ? 'SIGN_IN_PAGE' : 'UNSUPPORTED_PAGE';
        }
        return 'GOOGLE_MEET_PAGE';
      } catch(e) {
        this._logger.error('Error verifying if Google Meet bot is on the Google Meet page...', { error: e, message: e?.message });
        return null;
      }
    };

    const googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();
    if (googleMeetPageStatus === 'SIGN_IN_PAGE') {
      this._logger.info('Exiting now as meeting requires sign in...', { googleMeetPageStatus, userId, teamId });
      throw new UnsupportedMeetingError('Meeting requires sign in', googleMeetPageStatus);
    }

    if (googleMeetPageStatus === 'UNSUPPORTED_PAGE') {
      this._logger.info('Google Meet bot is on the unsupported page...', { googleMeetPageStatus, userId, teamId });
    }

    this._logger.info('Waiting for the input field to be visible...');
    await retryActionWithWait(
      'Waiting for the input field',
      async () => await this.page.waitForSelector('input[type="text"][aria-label="Your name"]', { timeout: 10000 }),
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'text-input-field-wait', userId, this._logger, botId);
      }
    );
    
    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);

    this._logger.info('Filling the input field with the name...');
    await this.page.fill('input[type="text"][aria-label="Your name"]', name ? name : 'ScreenApp Notetaker');

    this._logger.info('Waiting for 10 seconds...');
    await this.page.waitForTimeout(10000);
    
    // Turn off microphone and camera before joining
    const toggleDevices = async () => {
      try {
        this._logger.info('Turning off microphone and camera before joining...');
        
        // TURN OFF MICROPHONE
        await this.findAndOptionallyClickElement(
          this.page,
          "//div[@role='button' and @aria-label='Turn off microphone']",
          this._logger
        );

        // TURN OFF WEBCAM
        await this.findAndOptionallyClickElement(
          this.page,
          "//div[@role='button' and @aria-label='Turn off camera']",
          this._logger
        );

        this._logger.info('Finished toggling camera and microphone');
      } catch (error) {
        this._logger.warn('Error toggling devices', error?.message);
      }
    };

    await toggleDevices();
    
    await retryActionWithWait(
      'Clicking the "Ask to join" button',
      async () => {
        // Using the Order of most probable detection
        const possibleTexts = [
          'Ask to join',
          'Join now',
          'Join anyway',
        ];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = await this.page.locator('button', { hasText: new RegExp(text.toLocaleLowerCase(), 'i') }).first();
            if (await button.count() > 0) {
              await button.click({ timeout: 5000 });
              buttonClicked = true;
              this._logger.info(`Success clicked using "${text}" action...`);
              break;
            }
          } catch(err) {
            this._logger.warn(`Unable to click using "${text}" action...`);
          }
        }

        // Throws to initiate retries
        if (!buttonClicked) {
          throw new Error('Unable to complete the join action...');
        }
      },
      this._logger,
      3,
      15000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'ask-to-join-button-click', userId, this._logger, botId);
      }
    );

    // Do this to ensure meeting bot has joined the meeting

    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to admit the bot

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;

      const waitAtLobbyPromise = new Promise<boolean>((resolveWaiting) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveWaiting(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            const detectLobbyModeHostWaitingText = async (): Promise<'WAITING_FOR_HOST_TO_ADMIT_BOT' | 'WAITING_REQUEST_TIMEOUT' | 'LOBBY_MODE_NOT_ACTIVE' | 'UNABLE_TO_DETECT_LOBBY_MODE'> => {
              try {
                const lobbyModeHostWaitingText = await this.page.getByText(GOOGLE_LOBBY_MODE_HOST_TEXT);
                if (await lobbyModeHostWaitingText.count() > 0 && await lobbyModeHostWaitingText.isVisible()) {
                  return 'WAITING_FOR_HOST_TO_ADMIT_BOT';
                }

                const lobbyModeRequestTimeoutText = await this.page.getByText(GOOGLE_REQUEST_TIMEOUT);
                if (await lobbyModeRequestTimeoutText.count() > 0 && await lobbyModeRequestTimeoutText.isVisible()) {
                  return 'WAITING_REQUEST_TIMEOUT';
                }

                return 'LOBBY_MODE_NOT_ACTIVE';
              }
              catch (e) {
                this._logger.error('Error detecting lobby mode host waiting text...', { error: e, message: e?.message });
                return 'UNABLE_TO_DETECT_LOBBY_MODE';
              }
            };

            let peopleElement;
            let callButtonElement;
            let botWasDeniedAccess = false;

            try {
              peopleElement = await this.page.waitForSelector('button[aria-label="People"]', { timeout: 5000 });
            } catch(e) {
              this._logger.error(
                'wait error', { error: e }
              );
              //do nothing
            }

            try {
              callButtonElement = await this.page.waitForSelector('button[aria-label="Leave call"]', { timeout: 5000 });
            } catch(e) {
              this._logger.error(
                'wait error', { error: e }
              );
              //do nothing
            }

            if (peopleElement || callButtonElement) {
              // Here check the "lobby mode" that waits for the Host to join the meeting or for the Host to admit the bot
              const lobbyModeHostWaitingText = await detectLobbyModeHostWaitingText();
              if (lobbyModeHostWaitingText === 'WAITING_FOR_HOST_TO_ADMIT_BOT') {
                this._logger.info('Lobbdy Mode: Google Meet Bot is waiting for the host to admit it...', { userId, teamId });
              } else if (lobbyModeHostWaitingText === 'WAITING_REQUEST_TIMEOUT') {
                this._logger.info('Lobby Mode: Google Meet Bot join request timed out...', { userId, teamId });
                clearInterval(waitInterval);
                clearTimeout(waitTimeout);
                resolveWaiting(false);
                return;
              } else {
                // Additional check: Verify we can actually see participants (not just UI buttons)
                // The "Leave call" button can exist even in lobby waiting state
                try {
                  const participantCountDetected = await this.page.evaluate(() => {
                    try {
                      // Look for People button with participant count
                      const peopleButton = document.querySelector('button[aria-label^="People"]');
                      if (peopleButton) {
                        const ariaLabel = peopleButton.getAttribute('aria-label');
                        // Check if we can see participant count (e.g., "People - 2 joined")
                        const match = ariaLabel?.match(/People.*?(\d+)/);
                        if (match && parseInt(match[1]) >= 1) {
                          return true;
                        }
                      }

                      // Alternative: Check if participant count is visible in the DOM
                      const allButtons = Array.from(document.querySelectorAll('button'));
                      for (const btn of allButtons) {
                        const label = btn.getAttribute('aria-label');
                        if (label && /People.*?\d+/.test(label)) {
                          return true;
                        }
                      }

                      return false;
                    } catch (e) {
                      return false;
                    }
                  });

                  if (participantCountDetected) {
                    this._logger.info('Google Meet Bot is entering the meeting...', { userId, teamId });
                    clearInterval(waitInterval);
                    clearTimeout(waitTimeout);
                    resolveWaiting(true);
                    return;
                  } else {
                    this._logger.info('People button found but participant count not visible yet - continuing to wait...', { userId, teamId });
                    return;
                  }
                } catch (e) {
                  this._logger.error('Error checking participant visibility', { error: e });
                  return;
                }
              }              
            }

            try {
              const deniedText = await this.page.getByText(GOOGLE_REQUEST_DENIED);
              if (await deniedText.count() > 0 && await deniedText.isVisible()) {
                botWasDeniedAccess = true;
              }
            }
            catch(e) {
              //do nothing
            }
            if (botWasDeniedAccess) {
              this._logger.info('Google Meet Bot is denied access to the meeting...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(false);
            }
          } catch(e) {
            this._logger.error(
              'wait error', { error: e }
            );
            // Do nothing
          }
        }, 20000);
      });

      const waitingAtLobbySuccess = await waitAtLobbyPromise;
      if (!waitingAtLobbySuccess) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(GOOGLE_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess, bodyText });

        throw new WaitingAtLobbyRetryError('Google Meet bot could not enter the meeting...', bodyText ?? '', !userDenied, 2);
      }
    } catch(lobbyError) {
      this._logger.info('Closing the browser on error...', lobbyError);
      await this.page.context().browser()?.close();

      throw lobbyError;
    }

    pushState('joined');

    try {
      this._logger.info('Waiting for the "Got it" button...');
      await this.page.waitForSelector('button:has-text("Got it")', { timeout: 15000 });

      this._logger.info('Going to click all visible "Got it" buttons...');

      let gotItButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations

      while (true) {
        const visibleButtons = await this.page.locator('button:visible', {
          hasText: 'Got it',
        }).all();
      
        const currentButtonCount = visibleButtons.length;
        
        if (currentButtonCount === 0) {
          break;
        }
        
        // Check if button count hasn't changed (indicating we might be stuck)
        if (currentButtonCount === previousButtonCount) {
          consecutiveNoChangeCount++;
          if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
            this._logger.warn(`Button count hasn't changed for ${maxConsecutiveNoChange} iterations, stopping`);
            break;
          }
        } else {
          consecutiveNoChangeCount = 0;
        }
        
        previousButtonCount = currentButtonCount;

        for (const btn of visibleButtons) {
          try {
            await btn.click({ timeout: 5000 });
            gotItButtonsClicked++;
            this._logger.info(`Clicked a "Got it" button #${gotItButtonsClicked}`);
            
            await this.page.waitForTimeout(2000);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', { error: err });
          }
        }
      
        await this.page.waitForTimeout(2000);
      }
    } catch (error) {
      // Log and ignore this error
      this._logger.info('"Got it" modals might be missing...', { error });
    }

    // Speak greeting using TTS after joining
    await this.speakInMeeting('Hello, I am the meeting bot my name is CDMBASE and I have joined the meeting. I will be recording this session. This is the Mock data for the meeting bot.');

    // Start voice-activated listening for responses
    this._logger.info('Starting voice-activated listening...');
    await this.startVoiceActivatedListening();

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ teamId, eventId, userId, botId, uploader });

    pushState('finished');
  }

  /**
   * Speak text in the meeting using Deepgram TTS
   * @param text - The text to speak
   */
  private async speakInMeeting(text: string): Promise<void> {
    try {
      // Check if Deepgram API key is configured
      if (!config.deepgramApiKey) {
        this._logger.warn('Deepgram API key not configured, skipping TTS');
        return;
      }

      this._logger.info('Generating TTS audio for meeting', { text });

      // Set up console log capture for TTS debugging (before any browser code runs)
      this.page.on('console', async msg => {
        try {
          await browserLogCaptureCallback(this._logger, msg);
        } catch(err) {
          // Ignore errors in log capture
        }
      });

      // Initialize TTS service
      const ttsService = new TtsService(this._logger);
      
      // Generate audio using Deepgram FIRST (before enabling mic)
      const audioBuffer = await ttsService.textToSpeech(text);
      const audioBase64 = audioBuffer.toString('base64');

      // Pre-create and store TTS stream BEFORE enabling microphone
      // This ensures getUserMedia override can return it immediately
      this._logger.info('Pre-creating TTS stream in browser...');
      const ttsStreamCreated = await this.page.evaluate(async (base64Audio: string) => {
        try {
          console.log('[TTS] Starting TTS stream creation...');
          
          // Decode base64 audio to ArrayBuffer
          const binaryString = atob(base64Audio);
          const audioBytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            audioBytes[i] = binaryString.charCodeAt(i);
          }

          console.log('[TTS] Decoded audio, creating AudioContext...');
          // Create audio context
          const audioContext = new AudioContext({ sampleRate: 24000 });
          
          console.log('[TTS] Decoding audio data...');
          // Decode audio data
          const audioBuffer = await audioContext.decodeAudioData(audioBytes.buffer);
          
          console.log('[TTS] Creating buffer source...');
          // Create buffer source for TTS audio
          const ttsSource = audioContext.createBufferSource();
          ttsSource.buffer = audioBuffer;

          console.log('[TTS] Creating MediaStreamDestination...');
          // Create a MediaStreamDestination to output our TTS audio
          const destination = audioContext.createMediaStreamDestination();
          
          // Connect TTS source to destination
          ttsSource.connect(destination);

          // Get the TTS audio track
          const ttsTrack = destination.stream.getAudioTracks()[0];
          
          if (!ttsTrack) {
            throw new Error('Failed to create TTS audio track');
          }

          console.log('[TTS] Creating MediaStream with TTS track...');
          // Create a MediaStream with just the TTS track
          const ttsStream = new MediaStream([ttsTrack]);
          
          // Store it globally so the getUserMedia override can return it
          (window as any).__ttsAudioStream = ttsStream;
          (window as any).__ttsAudioSource = ttsSource;
          (window as any).__ttsAudioContext = audioContext;
          
          console.log('[TTS] TTS stream pre-created and stored globally');
          return { success: true, trackId: ttsTrack.id };
        } catch (error: any) {
          console.error('[TTS] Error pre-creating TTS stream:', error?.message);
          return { success: false, error: error?.message };
        }
      }, audioBase64);
      
      this._logger.info('TTS stream creation result', ttsStreamCreated);
      
      if (!ttsStreamCreated.success) {
        this._logger.error('Failed to create TTS stream', { error: ttsStreamCreated.error });
        return;
      }

      // Try to enable microphone - try multiple selectors and methods
      this._logger.info('Enabling microphone for TTS...');
      
      // Method 1: Try XPath selectors
      const micSelectors = [
        "//div[@role='button' and @aria-label='Turn on microphone']",
        "//div[@role='button' and contains(@aria-label, 'microphone') and contains(@aria-label, 'on')]",
        "//button[@aria-label='Turn on microphone']",
        "//button[contains(@aria-label, 'microphone') and contains(@aria-label, 'on')]",
      ];

      let micEnabled = false;
      for (const selector of micSelectors) {
        const enabled = await this.findAndOptionallyClickElement(
          this.page,
          selector,
          this._logger
        );
        if (enabled) {
          micEnabled = true;
          this._logger.info('Microphone enabled using XPath selector', { selector });
          break;
        }
      }

      // Method 2: Try Playwright locators if XPath didn't work
      if (!micEnabled) {
        try {
          const micButton = this.page.getByRole('button', { name: /turn on microphone/i }).first();
          const count = await micButton.count();
          if (count > 0 && await micButton.isVisible({ timeout: 3000 }).catch(() => false)) {
            await micButton.click();
            micEnabled = true;
            this._logger.info('Microphone enabled using Playwright locator');
          }
        } catch (err) {
          this._logger.info('Could not enable microphone using Playwright locator', { error: err?.message });
        }
      }

      // Method 3: Try to find any microphone button and click it
      if (!micEnabled) {
        try {
          const allButtons = await this.page.locator('button, div[role="button"]').all();
          for (const btn of allButtons) {
            try {
              const ariaLabel = await btn.getAttribute('aria-label');
              if (ariaLabel && /microphone/i.test(ariaLabel) && /on|unmute/i.test(ariaLabel)) {
                const isVisible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
                if (isVisible) {
                  await btn.click();
                  micEnabled = true;
                  this._logger.info('Microphone enabled by finding button with aria-label', { ariaLabel });
                  break;
                }
              }
            } catch (e) {
              // Continue to next button
            }
          }
        } catch (err) {
          this._logger.info('Could not enable microphone by searching buttons', { error: err?.message });
        }
      }

      if (!micEnabled) {
        this._logger.warn('Could not enable microphone button, but will attempt to inject audio anyway');
      }

      // Wait a bit for microphone to activate
      await this.page.waitForTimeout(2000);

      // Force Google Meet to re-request audio by toggling mic off and on
      // This will trigger getUserMedia which our override will intercept
      this._logger.info('Toggling microphone to trigger getUserMedia...');
      await this.findAndOptionallyClickElement(
        this.page,
        "//button[@aria-label='Turn off microphone']",
        this._logger
      );
      await this.page.waitForTimeout(500);
      await this.findAndOptionallyClickElement(
        this.page,
        "//button[@aria-label='Turn on microphone']",
        this._logger
      );
      await this.page.waitForTimeout(2000);

      // Now start playing the TTS audio
      this._logger.info('Starting TTS audio playback in browser...');
      const playbackResult = await this.page.evaluate(async () => {
        try {
          console.log('[TTS] Looking for pre-created TTS stream...');
          const ttsStream = (window as any).__ttsAudioStream;
          const ttsSource = (window as any).__ttsAudioSource;
          const audioContext = (window as any).__ttsAudioContext;
          
          if (!ttsStream || !ttsSource) {
            const error = 'TTS stream not found - it should have been pre-created';
            console.error('[TTS]', error);
            return { success: false, error };
          }

          console.log('[TTS] TTS stream found, starting playback...');
          const ttsTrack = ttsStream.getAudioTracks()[0];
          console.log('[TTS] TTS track ID:', ttsTrack.id);

          // Now we need to trigger Google Meet to request audio again
          // The getUserMedia override will return our TTS stream
          // But Google Meet already has its stream, so we need to make it re-request
          
          // Try to find and replace in RTCPeerConnection
          // First check the captured peer connections from our hook
          let audioReplaced = false;
          try {
            const windowObj = window as any;
            let possiblePCs: any[] = [];
            
            // Method 1: Use captured peer connections from our hook
            if (windowObj.__googleMeetPeerConnections) {
              possiblePCs = windowObj.__googleMeetPeerConnections;
              console.log(`[TTS] Found ${possiblePCs.length} RTCPeerConnection(s) from hook`);
            }
            
            // Method 2: Also search in window object as backup
            if (possiblePCs.length === 0) {
              function searchForPC(obj: any, visited: WeakSet<any>, depth: number = 0): void {
                if (depth > 3 || !obj || typeof obj !== 'object') return;
                if (visited.has(obj)) return;
                visited.add(obj);
                
                try {
                  if (obj instanceof RTCPeerConnection) {
                    possiblePCs.push(obj);
                    return;
                  }
                  
                  if (obj.getSenders && typeof obj.getSenders === 'function') {
                    try {
                      const senders = obj.getSenders();
                      if (senders && senders.length > 0) {
                        possiblePCs.push(obj);
                        return;
                      }
                    } catch (e) {
                      // Not valid
                    }
                  }
                  
                  for (const key of Object.keys(obj).slice(0, 30)) {
                    try {
                      if (!key.startsWith('_') && key !== 'prototype') {
                        searchForPC(obj[key], visited, depth + 1);
                      }
                    } catch (e) {
                      // Ignore
                    }
                  }
                } catch (e) {
                  // Ignore
                }
              }
              
              searchForPC(windowObj, new WeakSet());
              console.log(`[TTS] Found ${possiblePCs.length} potential RTCPeerConnection(s) from search`);
            }
            
            // Try to replace audio tracks in found peer connections
            for (const pc of possiblePCs) {
              try {
                const senders = pc.getSenders();
                console.log(`[TTS] Checking RTCPeerConnection with ${senders.length} senders`);
                for (const sender of senders) {
                  if (sender.track && sender.track.kind === 'audio') {
                    console.log('[TTS] Found audio sender, replacing track...');
                    console.log('[TTS] Original track ID:', sender.track.id);
                    console.log('[TTS] TTS track ID:', ttsTrack.id);
                    await sender.replaceTrack(ttsTrack);
                    audioReplaced = true;
                    console.log('[TTS] Successfully replaced track in RTCPeerConnection!');
                    break;
                  }
                }
                if (audioReplaced) break;
              } catch (e) {
                console.warn('[TTS] Error accessing RTCPeerConnection:', e);
              }
            }
          } catch (error) {
            console.error('[TTS] Error finding RTCPeerConnection:', error);
          }

          // If we couldn't replace in RTCPeerConnection, the getUserMedia override will handle it
          // when Google Meet re-requests audio (e.g., when mic is toggled)
          if (!audioReplaced) {
            console.log('[TTS] RTCPeerConnection replacement not found, relying on getUserMedia override');
            console.log('[TTS] TTS stream is ready - Google Meet will use it on next getUserMedia call');
          }

          // Start playing TTS audio
          ttsSource.start(0);
          console.log('[TTS] TTS audio started playing at', new Date().toISOString());
          
          // Wait for audio to finish playing
          await new Promise<void>((resolve) => {
            ttsSource.onended = () => {
              console.log('[TTS] TTS audio playback completed at', new Date().toISOString());
              
              // Cleanup
              ttsSource.disconnect();
              
              // Don't stop the track if we successfully replaced it (let it finish naturally)
              // Only stop if we didn't replace it
              if (!audioReplaced) {
                ttsTrack.stop();
              }
              
              // Don't close audioContext - let the track finish transmitting
              // audioContext.close();
              
              console.log('[TTS] TTS audio injection completed');
              resolve();
            };
          });
          
          return { success: true, audioReplaced, message: 'TTS audio playback completed' };
        } catch (error: any) {
          console.error('[TTS] Error injecting TTS audio into Google Meet:', error?.message);
          console.error('[TTS] Error stack:', error?.stack);
          return { success: false, error: error?.message };
        }
      });
      
      this._logger.info('TTS playback result', playbackResult);
      
      if (!playbackResult.success) {
        this._logger.error('TTS playback failed', { error: playbackResult.error });
      } else if (playbackResult.audioReplaced) {
        this._logger.info('TTS audio successfully injected into RTCPeerConnection');
      } else {
        this._logger.warn('TTS audio played but may not have been injected into Google Meet');
      }

      // Wait a bit for audio to finish being transmitted
      await this.page.waitForTimeout(2000);

      // Keep microphone on for voice-activated listening
      // Only turn off if voice listening is not active
      const isVoiceListeningActive = await this.page.evaluate(() => {
        return !!(window as any).__voiceListeningActive;
      });

      if (!isVoiceListeningActive) {
        // Turn microphone back off after speaking (only if voice listening is not active)
        this._logger.info('Disabling microphone after TTS...');
        const micOffSelectors = [
          "//div[@role='button' and @aria-label='Turn off microphone']",
          "//div[@role='button' and contains(@aria-label, 'microphone') and contains(@aria-label, 'off')]",
          "//button[@aria-label='Turn off microphone']",
          "//button[contains(@aria-label, 'microphone') and contains(@aria-label, 'off')]",
        ];

        for (const selector of micOffSelectors) {
          const disabled = await this.findAndOptionallyClickElement(
            this.page,
            selector,
            this._logger
          );
          if (disabled) {
            this._logger.info('Microphone disabled using selector', { selector });
            break;
          }
        }
      } else {
        this._logger.info('Keeping microphone on for voice-activated listening');
      }

      this._logger.info('Successfully spoke text in meeting', { text });
    } catch (error: any) {
      // Log error but don't fail the meeting join process
      this._logger.error('Error speaking in meeting', { error: error?.message, text });
    }
  }

  /**
   * Start voice-activated listening for trigger phrases
   * Listens for "hi" and "you can start"/"u can start" and responds accordingly
   * 
   * Note: Uses browser's Web Speech API (SpeechRecognition) which listens to microphone input.
   * The microphone must be enabled for this to work. In a meeting context, this will pick up
   * audio from the microphone, which may include meeting audio if there's speaker feedback.
   */
  private _deepgramConnectionId: string | null = null;

  private async startVoiceActivatedListening(): Promise<void> {
    try {
      this._logger.info('Setting up voice-activated listening...');

      // Ensure microphone is enabled for voice listening
      this._logger.info('Ensuring microphone is enabled for voice listening...');
      const micSelectors = [
        "//button[@aria-label='Turn on microphone']",
        "//div[@role='button' and @aria-label='Turn on microphone']",
        "//button[contains(@aria-label, 'microphone') and contains(@aria-label, 'on')]",
        "//div[@role='button' and contains(@aria-label, 'microphone') and contains(@aria-label, 'on')]",
      ];

      let micEnabled = false;
      for (const selector of micSelectors) {
        const enabled = await this.findAndOptionallyClickElement(
          this.page,
          selector,
          this._logger
        );
        if (enabled) {
          micEnabled = true;
          this._logger.info('Microphone enabled for voice listening', { selector });
          break;
        }
      }

      if (!micEnabled) {
        this._logger.warn('Could not enable microphone for voice listening - speech recognition may not work');
      }

      // Wait a bit for microphone to activate
      await this.page.waitForTimeout(1000);

      // Mark voice listening as active BEFORE starting recognition
      // This ensures speakInMeeting knows to keep mic on
      await this.page.evaluate(() => {
        (window as any).__voiceListeningActive = true;
      });

      // Expose a function that the browser can call to trigger AI-powered TTS responses
      await this.page.exposeFunction('__triggerBotResponse', async (userMessage: string) => {
        this._logger.info('Voice input detected, generating AI response', { userMessage });
        
        try {
          let responseText: string;
          
          if (this._openAI) {
            // Use OpenAI to generate response
            responseText = await this._openAI.generateResponse(userMessage);
            this._logger.info('Generated AI response', { userMessage, responseText });
          } else {
            // Fallback if OpenAI is not available
            this._logger.warn('OpenAI not available, using fallback response');
            responseText = "I'm here to help with your onboarding. How can I assist you today?";
          }
          
          await this.speakInMeeting(responseText);
        } catch (error: any) {
          this._logger.error('Error generating AI response', { error: error?.message, userMessage });
          // Fallback response
          await this.speakInMeeting("I'm here to help with your onboarding. How can I assist you today?");
        }
      });

      // Create a real-time Deepgram connection for streaming transcription
      this._deepgramConnectionId = `voice-${this._correlationId}`;
      let latestTranscript = '';
      let transcriptTimeout: NodeJS.Timeout | null = null;
      
      if (this._sttService) {
        this._sttService.createLiveConnection(this._deepgramConnectionId, (transcript: string, isFinal: boolean) => {
          if (isFinal && transcript.trim().length > 2) {
            latestTranscript = transcript.trim();
            this._logger.info('Received final transcript from Deepgram real-time', { transcript: latestTranscript });
            
            // Clear any pending timeout
            if (transcriptTimeout) {
              clearTimeout(transcriptTimeout);
            }
            
            // Trigger bot response
            this.page.evaluate(async (transcript: string) => {
              try {
                await (window as any).__triggerBotResponse(transcript);
              } catch (error: any) {
                console.error('[Voice] Error triggering bot response:', error);
              }
            }, latestTranscript).catch((error: any) => {
              this._logger.error('Error triggering bot response from real-time transcript', { error: error?.message });
            });
          }
        });
        this._logger.info('Created Deepgram real-time connection', { connectionId: this._deepgramConnectionId });
      }

      // Expose a function to send audio chunks to Deepgram real-time API
      await this.page.exposeFunction('__sendAudioToDeepgram', async (audioBase64: string) => {
        if (!this._sttService || !this._deepgramConnectionId) {
          return { success: false };
        }
        
        try {
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          
          // Send to real-time connection
          this._sttService.sendToLiveConnection(this._deepgramConnectionId, audioBuffer);
          return { success: true };
        } catch (error: any) {
          this._logger.error('Error sending audio to Deepgram real-time', { 
            error: error?.message 
          });
          return { success: false };
        }
      });

      // Keep the old function as fallback for now
      await this.page.exposeFunction('__processAudioChunk', async (audioBase64: string) => {
        this._logger.info('Received audio chunk for transcription (fallback)', { chunkSize: audioBase64.length });
        
        if (!this._sttService) {
          this._logger.warn('STT service not available for audio transcription');
          return { success: false, transcript: '' };
        }
        
        try {
          const audioBuffer = Buffer.from(audioBase64, 'base64');
          this._logger.info('Decoded audio buffer', { bufferSize: audioBuffer.length });
          
          const transcript = await this._sttService.transcribe(audioBuffer);
          this._logger.info('Transcribed audio chunk', { transcript, transcriptLength: transcript.length });
          return { success: true, transcript };
        } catch (error: any) {
          this._logger.error('Error transcribing audio chunk', { 
            error: error?.message,
            errorStack: error?.stack 
          });
          return { success: false, transcript: '' };
        }
      });

      // Start remote audio capture and transcription in the browser
      await this.page.evaluate(() => {
        console.log('[Voice] Starting remote audio capture from meeting...');
        
        // Track if we're currently speaking to avoid interrupting ourselves
        let isSpeaking = false;
        let audioContext: AudioContext | null = null;
        let analyser: AnalyserNode | null = null;
        let remoteAudioStream: MediaStream | null = null;
        let transcriptionInterval: NodeJS.Timeout | null = null;
        
        // Function to find and capture remote audio tracks from RTCPeerConnection
        async function captureRemoteAudio(): Promise<MediaStream | null> {
          try {
            const windowObj = window as any;
            const peerConnections = windowObj.__googleMeetPeerConnections || [];
            
            console.log(`[Voice] Found ${peerConnections.length} RTCPeerConnection(s)`);
            
            const allAudioTracks: MediaStreamTrack[] = [];
            
            for (const pc of peerConnections) {
              try {
                // Get receivers (incoming audio/video)
                const receivers = pc.getReceivers();
                console.log(`[Voice] Checking RTCPeerConnection with ${receivers.length} receivers`);
                
                for (const receiver of receivers) {
                  const track = receiver.track;
                  if (track && track.kind === 'audio' && track.readyState === 'live') {
                    console.log('[Voice] Found remote audio track:', track.id, 'muted:', track.muted);
                    allAudioTracks.push(track);
                  }
                }
              } catch (e) {
                console.warn('[Voice] Error accessing RTCPeerConnection:', e);
              }
            }
            
            // Prefer unmuted tracks, but also collect muted ones as fallback
            const unmutedTracks = allAudioTracks.filter(t => !t.muted);
            const mutedTracks = allAudioTracks.filter(t => t.muted);
            
            if (unmutedTracks.length > 0) {
              console.log(`[Voice] Found ${unmutedTracks.length} unmuted remote audio track(s), using first one`);
              return new MediaStream([unmutedTracks[0]]);
            } else if (mutedTracks.length > 0) {
              console.warn(`[Voice] All ${mutedTracks.length} remote audio track(s) are muted - will try to capture anyway`);
              console.warn('[Voice] Note: MediaRecorder may not capture audio from muted tracks');
              return new MediaStream([mutedTracks[0]]);
            }
            
            // Also search for remote tracks in the window
            function searchForRemoteTracks(obj: any, visited: WeakSet<any>, depth: number = 0): MediaStreamTrack[] {
              const found: MediaStreamTrack[] = [];
              if (depth > 4 || !obj || typeof obj !== 'object') return found;
              if (visited.has(obj)) return found;
              visited.add(obj);
              
              try {
                if (obj instanceof MediaStreamTrack && obj.kind === 'audio' && obj.readyState === 'live') {
                  // Check if it's a remote track (not our own)
                  if (obj.id && !obj.id.includes('tts')) {
                    found.push(obj);
                  }
                }
                
                for (const key of Object.keys(obj).slice(0, 50)) {
                  try {
                    if (!key.startsWith('_') && key !== 'prototype') {
                      found.push(...searchForRemoteTracks(obj[key], visited, depth + 1));
                    }
                  } catch (e) {
                    // Ignore
                  }
                }
              } catch (e) {
                // Ignore
              }
              
              return found;
            }
            
            const remoteTracks = searchForRemoteTracks(windowObj, new WeakSet());
            if (remoteTracks.length > 0) {
              const unmuted = remoteTracks.filter(t => !t.muted);
              const muted = remoteTracks.filter(t => t.muted);
              
              if (unmuted.length > 0) {
                console.log('[Voice] Found unmuted remote audio track via search:', unmuted[0].id);
                return new MediaStream([unmuted[0]]);
              } else if (muted.length > 0) {
                console.warn('[Voice] Found muted remote audio track via search:', muted[0].id);
                return new MediaStream([muted[0]]);
              }
            }
            
            return null;
          } catch (error) {
            console.error('[Voice] Error capturing remote audio:', error);
            return null;
          }
        }
        
        // Function to process audio and transcribe using Web Speech API
        // Since Web Speech API only works with mic, we'll route remote audio through a workaround
        async function startRemoteAudioTranscription() {
          try {
            // Wait a bit for meeting to establish connections
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Continuously try to capture remote audio
            let retryCount = 0;
            const maxRetries = 10;
            
            async function tryCaptureAndTranscribe() {
              remoteAudioStream = await captureRemoteAudio();
              
              if (!remoteAudioStream) {
                retryCount++;
                if (retryCount < maxRetries) {
                  console.log(`[Voice] Could not capture remote audio, retrying... (${retryCount}/${maxRetries})`);
                  setTimeout(tryCaptureAndTranscribe, 5000);
                  return;
                } else {
                  console.warn('[Voice] Could not capture remote audio after multiple attempts, falling back to microphone');
                  // Fall back to microphone-based recognition
                  startMicrophoneRecognition();
                  return;
                }
              }
              
              console.log('[Voice] Remote audio stream captured, setting up transcription...');
              
              if (!remoteAudioStream) {
                console.error('[Voice] Remote audio stream is null, cannot proceed');
                return;
              }
              
              // Check if the track is actually active and has audio
              const tracks = remoteAudioStream.getAudioTracks();
              console.log('[Voice] Remote audio stream has', tracks.length, 'audio track(s)');
              for (const track of tracks) {
                console.log('[Voice] Track ID:', track.id, 'enabled:', track.enabled, 'readyState:', track.readyState, 'muted:', track.muted);
                
                // Monitor mute state changes
                track.onmute = () => {
                  console.warn('[Voice] Track became muted:', track.id);
                };
                
                track.onunmute = () => {
                  console.log('[Voice] Track became unmuted:', track.id, '- PCM capture should now work');
                };
              }
              
              // Check if track is muted - if so, we'll use AudioContext to monitor and capture audio
              const isMuted = tracks.some(t => t.muted);
              if (isMuted) {
                console.warn('[Voice] Remote audio track is muted - MediaRecorder will only capture empty chunks');
                console.warn('[Voice] Will monitor for unmute events and use AudioContext to detect audio activity');
              }
              
              // Create AudioContext to capture raw PCM audio (better than MediaRecorder for transcription)
              const audioContext = new AudioContext({ sampleRate: 16000 });
              const source = audioContext.createMediaStreamSource(remoteAudioStream);
              const analyser = audioContext.createAnalyser();
              analyser.fftSize = 2048;
              analyser.smoothingTimeConstant = 0.8;
              source.connect(analyser);
              
              // Capture raw PCM audio using ScriptProcessorNode (deprecated but widely supported)
              // This gives us complete, valid audio buffers instead of fragmented WebM chunks
              const bufferSize = 4096;
              const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
              let pcmAudioBuffers: Float32Array[] = [];
              let lastTranscriptionTime = 0;
              let lastAudioActivityTime = Date.now();
              
              let bufferCount = 0;
              scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
                const inputBuffer = event.inputBuffer;
                const channelData = inputBuffer.getChannelData(0);
                
                // Always collect audio data (we'll filter during processing)
                pcmAudioBuffers.push(new Float32Array(channelData));
                bufferCount++;
                
                // Check for audio activity
                let sum = 0;
                let max = 0;
                for (let i = 0; i < channelData.length; i++) {
                  const abs = Math.abs(channelData[i]);
                  sum += abs;
                  max = Math.max(max, abs);
                }
                const average = sum / channelData.length;
                
                if (average > 0.001 || max > 0.01) {
                  lastAudioActivityTime = Date.now();
                }
                
                // Log periodically to show we're capturing audio
                if (bufferCount % 100 === 0) {
                  console.log(`[Voice] Captured ${bufferCount} audio buffers, total samples: ${pcmAudioBuffers.reduce((sum, buf) => sum + buf.length, 0)}`);
                }
              };
              
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContext.destination);
              
              // Helper function to convert AudioBuffer to WAV format
              function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
                const length = buffer.length;
                const numberOfChannels = buffer.numberOfChannels;
                const sampleRate = buffer.sampleRate;
                const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
                const view = new DataView(arrayBuffer);
                const channels: Float32Array[] = [];
                let offset = 0;
                let pos = 0;
                
                // Write WAV header
                const setUint16 = (data: number) => {
                  view.setUint16(pos, data, true);
                  pos += 2;
                };
                const setUint32 = (data: number) => {
                  view.setUint32(pos, data, true);
                  pos += 4;
                };
                
                // RIFF identifier
                setUint32(0x46464952); // "RIFF"
                setUint32(36 + length * numberOfChannels * 2); // File length - 8
                setUint32(0x45564157); // "WAVE"
                
                // fmt chunk
                setUint32(0x20746d66); // "fmt "
                setUint32(16); // Chunk size
                setUint16(1); // Audio format (1 = PCM)
                setUint16(numberOfChannels);
                setUint32(sampleRate);
                setUint32(sampleRate * numberOfChannels * 2); // Byte rate
                setUint16(numberOfChannels * 2); // Block align
                setUint16(16); // Bits per sample
                
                // data chunk
                setUint32(0x61746164); // "data"
                setUint32(length * numberOfChannels * 2);
                
                // Write interleaved data
                for (let i = 0; i < numberOfChannels; i++) {
                  channels.push(buffer.getChannelData(i));
                }
                
                while (pos < arrayBuffer.byteLength) {
                  for (let i = 0; i < numberOfChannels; i++) {
                    let sample = Math.max(-1, Math.min(1, channels[i][offset]));
                    sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                    view.setInt16(pos, sample, true);
                    pos += 2;
                  }
                  offset++;
                }
                
                return arrayBuffer;
              }
              
              // Process PCM audio buffers periodically and convert to WAV for Deepgram
              const transcriptionInterval = setInterval(async () => {
                if (isSpeaking) {
                  return;
                }
                
                const now = Date.now();
                const timeSinceLastActivity = now - lastAudioActivityTime;
                const timeSinceLastTranscription = now - lastTranscriptionTime;
                
                // Need at least some audio data
                if (pcmAudioBuffers.length === 0) {
                  return;
                }
                
                // Only process if we have enough audio data (at least 2 seconds) and enough time has passed
                const totalSamples = pcmAudioBuffers.reduce((sum, buf) => sum + buf.length, 0);
                const minSamples = 32000; // 2 seconds at 16kHz
                
                if (totalSamples < minSamples || timeSinceLastTranscription < 5000) {
                  if (totalSamples > 0) {
                    console.log(`[Voice] Waiting for more audio: ${totalSamples}/${minSamples} samples, time since last: ${timeSinceLastTranscription}ms`);
                  }
                  return;
                }
                
                // Check if there was recent audio activity (within last 5 seconds)
                if (timeSinceLastActivity > 5000) {
                  // No recent activity, clear buffers and wait
                  console.log('[Voice] No recent audio activity, clearing buffers');
                  pcmAudioBuffers = [];
                  return;
                }
                      
                try {
                  lastTranscriptionTime = now;
                  
                  // Combine all PCM buffers into a single AudioBuffer
                  const totalLength = pcmAudioBuffers.reduce((sum, buf) => sum + buf.length, 0);
                  
                  console.log(`[Voice] Processing ${pcmAudioBuffers.length} PCM buffers, total samples: ${totalLength} (${(totalLength / 16000).toFixed(2)} seconds)`);
                  
                  // Create a new AudioBuffer with combined data
                  const combinedBuffer = audioContext.createBuffer(1, totalLength, 16000);
                  const combinedData = combinedBuffer.getChannelData(0);
                  
                  let offset = 0;
                  for (const buffer of pcmAudioBuffers) {
                    combinedData.set(buffer, offset);
                    offset += buffer.length;
                  }
                  
                  // Convert to WAV format
                  const wavBuffer = audioBufferToWav(combinedBuffer);
                      
                      // Convert to base64
                  const uint8Array = new Uint8Array(wavBuffer);
                  let binaryString = '';
                  const chunkSize = 8192;
                  for (let i = 0; i < uint8Array.length; i += chunkSize) {
                    const chunk = uint8Array.subarray(i, i + chunkSize);
                    binaryString += String.fromCharCode.apply(null, Array.from(chunk));
                  }
                  const base64Audio = btoa(binaryString);
                  
                  // Send to Node.js for transcription
                  console.log('[Voice] Sending WAV audio for transcription (size:', wavBuffer.byteLength, 'bytes)...');
                      const result = await (window as any).__processAudioChunk(base64Audio);
                      
                  console.log('[Voice] Transcription result:', result);
                      
                      if (result.success && result.transcript && result.transcript.trim().length > 2) {
                        const transcript = result.transcript.trim();
                    console.log('[Voice] Speech detected:', transcript);
                        
                        console.log('[Voice] Sending to AI for response generation:', transcript);
                        isSpeaking = true;
                        
                        try {
                          await (window as any).__triggerBotResponse(transcript);
                          console.log('[Voice] AI response triggered successfully');
                          
                          setTimeout(() => {
                            isSpeaking = false;
                            console.log('[Voice] Ready to listen again');
                          }, 10000);
                        } catch (error: any) {
                          console.error('[Voice] Error triggering bot response:', error);
                          isSpeaking = false;
                        }
                      } else {
                    console.log('[Voice] No meaningful transcript found');
                      }
                      
                  // Clear buffers after processing
                  pcmAudioBuffers = [];
                    } catch (error: any) {
                  console.error('[Voice] Error processing PCM audio:', error);
                      console.error('[Voice] Error stack:', error?.stack);
                  pcmAudioBuffers = [];
                }
              }, 2000); // Check every 2 seconds
              
              console.log('[Voice] Remote audio transcription started (using PCM capture + Deepgram)');
            }
            
            tryCaptureAndTranscribe();
          } catch (error) {
            console.error('[Voice] Error starting remote audio transcription:', error);
            // Fall back to microphone recognition
            startMicrophoneRecognition();
          }
        }
        
        // Fallback: Use microphone-based recognition
        function startMicrophoneRecognition() {
          const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          
          if (!SpeechRecognition) {
            console.warn('[Voice] SpeechRecognition API not available');
            return;
          }
          
          console.log('[Voice] Starting microphone-based recognition (fallback)...');
          
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = false;
          recognition.lang = 'en-US';
          
          recognition.onresult = async (event: any) => {
            if (isSpeaking) {
              console.log('[Voice] Ignoring speech recognition result while bot is speaking');
              return;
            }

            const transcript = event.results[event.resultIndex][0].transcript;
            console.log('[Voice] Speech detected:', transcript);
            
            const trimmedTranscript = transcript.trim();
            if (trimmedTranscript.length < 2) {
              return;
            }
            
            console.log('[Voice] Sending to AI for response generation:', trimmedTranscript);
            isSpeaking = true;
            
            try {
              await (window as any).__triggerBotResponse(trimmedTranscript);
              console.log('[Voice] AI response triggered successfully');
              
              setTimeout(() => {
                isSpeaking = false;
                console.log('[Voice] Ready to listen again');
              }, 10000);
            } catch (error: any) {
              console.error('[Voice] Error triggering bot response:', error);
              isSpeaking = false;
            }
          };
          
          recognition.onerror = (event: any) => {
            if (event.error === 'no-speech') {
              console.log('[Voice] No speech detected (this is normal)');
              return;
            }
            console.error('[Voice] Speech recognition error:', event.error);
          };
          
          recognition.onend = () => {
            console.log('[Voice] Speech recognition ended, restarting...');
            setTimeout(() => {
              try {
                recognition.start();
              } catch (e: any) {
                if (!e.message?.includes('already started')) {
                  console.error('[Voice] Failed to restart recognition:', e);
                }
              }
            }, 1000);
          };
          
          try {
            recognition.start();
            console.log('[Voice] Microphone-based recognition started');
          } catch (error: any) {
            console.error('[Voice] Failed to start recognition:', error);
          }
        }
        
        // Start remote audio transcription (will fall back to microphone if needed)
        startRemoteAudioTranscription();
        
        return { success: true };
      });

      this._logger.info('Voice-activated listening started');
    } catch (error: any) {
      // Log error but don't fail the meeting join process
      this._logger.error('Error starting voice-activated listening', { error: error?.message });
    }
  }

  private async recordMeetingPage(
    { teamId, userId, eventId, botId, uploader }: 
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    const inactivityLimit = config.inactivityLimit * 60 * 1000;

    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async msg => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch(err) {
        this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
      }
    });

    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        this._logger.info('Attempt to end meeting early...');
        waitingPromise.resolveEarly();
      } catch (error) {
        console.error('Could not process meeting end event', error);
      }
    });

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType }: 
      { teamId:string, userId: string, duration: number, inactivityLimit: number, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityParticipantDetectionTimeout: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;
        let isOnValidGoogleMeetPageInterval: NodeJS.Timeout;

        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('Will activate the inactivity detection after', activateInactivityDetectionAfter);

          // Check for the availability of the mediaDevices API
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.error('MediaDevices or getDisplayMedia not supported in this browser.');
            return;
          }
          
          const stream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
            },
            preferCurrentTab: true,
          });

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;
          
          if (!hasAudioTracks) {
            console.warn('No audio tracks available for silence detection. Will rely only on presence detection.');
          }

          let options: MediaRecorderOptions = {};
          if (MediaRecorder.isTypeSupported(primaryMimeType)) {
            console.log(`Media Recorder will use ${primaryMimeType} codecs...`);
            options = { mimeType: primaryMimeType };
          }
          else {
            console.warn(`Media Recorder did not find primary mime type codecs ${primaryMimeType}, Using fallback codecs ${secondaryMimeType}`);
            options = { mimeType: secondaryMimeType };
          }

          const mediaRecorder = new MediaRecorder(stream, { ...options });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          let dismissModalsInterval: NodeJS.Timeout;
          let lastDimissError: Error | null = null;

          const stopTheRecording = async () => {
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityParticipantDetectionTimeout) {
              clearTimeout(inactivityParticipantDetectionTimeout);
            }
            if (inactivitySilenceDetectionTimeout) {
              clearTimeout(inactivitySilenceDetectionTimeout);
            }

            if (loneTest) {
              clearTimeout(loneTest);
            }

            if (isOnValidGoogleMeetPageInterval) {
              clearInterval(isOnValidGoogleMeetPageInterval);
            }

            if (dismissModalsInterval) {
              clearInterval(dismissModalsInterval);
              if (lastDimissError && lastDimissError instanceof Error) {
                console.error('Error dismissing modals:', { lastDimissError, message: lastDimissError?.message });
              }
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let detectionFailures = 0;
          let loneTestDetectionActive = true;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures

          function detectLoneParticipantResilient(): void {
            const re = /^[0-9]+$/;
          
            function getContributorsCount(): number | undefined {
              function findPeopleButton() {
                try {
                  // 1. Try to locate using attribute "starts with"
                  let btn: Element | null | undefined = document.querySelector('button[aria-label^="People -"]');
                  if (btn) return btn;
                
                  // 2. Try to locate using attribute "contains"
                  btn = document.querySelector('button[aria-label*="People"]');
                  if (btn) return btn;
                
                  // 3. Try via regex on aria-label (for more complex patterns)
                  const allBtns = Array.from(document.querySelectorAll('button[aria-label]'));
                  btn = allBtns.find(b => {
                    const label = b.getAttribute('aria-label');
                    return label && /^People - \d+ joined$/.test(label);
                  });
                  if (btn) return btn;
                
                  // 4. Fallback: Look for button with a child icon containing "people"
                  btn = allBtns.find(b =>
                    Array.from(b.querySelectorAll('i')).some(i =>
                      i.textContent && i.textContent.trim() === 'people'
                    )
                  );
                  if (btn) return btn;
                
                  // 5. Not found
                  return null;
                } catch (error) {
                  console.log('Error finding people button:', error);
                  return null;
                }
              }

              // 1. Try main DOM with aria-label first
              try {
                const peopleBtn = findPeopleButton();
                if (peopleBtn) {
                  const divs = Array.from((peopleBtn.parentNode as HTMLElement)?.parentNode?.querySelectorAll('div') ?? []);
                  for (const node of divs) {
                    if (typeof (node as HTMLElement).innerText === 'string' && re.test((node as HTMLElement).innerText.trim())) {
                      return Number((node as HTMLElement).innerText.trim());
                    }
                  }
                }
              } catch {
                console.log('1 Error getting contributors count:', { root: document.body.innerText });
              }
          
              return undefined;
            }
          
            function retryWithBackoff(): void {
              loneTest = setTimeout(function check() {
                if (!loneTestDetectionActive) {
                  if (loneTest) {
                    clearTimeout(loneTest);
                  }
                  return;
                }
                let contributors: number | undefined;
                try {
                  contributors = getContributorsCount();
                  if (typeof contributors === 'undefined') {
                    detectionFailures++;
                    console.warn('Meet participant detection failed, retrying. Failure count:', detectionFailures);
                    // Log for debugging
                    if (detectionFailures >= maxDetectionFailures) {
                      console.log('Persistent detection failures:', { bodyText: `${document.body.innerText?.toString()}` });
                      loneTestDetectionActive = false;
                    }
                    retryWithBackoff();
                    return;
                  }
                  detectionFailures = 0;
                  if (contributors < 2) {
                    console.log('Bot is alone, ending meeting.');
                    loneTestDetectionActive = false;
                    stopTheRecording();
                    return;
                  }
                } catch (err) {
                  detectionFailures++;
                  console.error('Detection error:', err, detectionFailures);
                  retryWithBackoff();
                  return;
                }
                retryWithBackoff();
              }, 5000);
            }
          
            retryWithBackoff();
          }

          const detectIncrediblySilentMeeting = () => {
            // Only run silence detection if we have audio tracks
            if (!hasAudioTracks) {
              console.warn('Skipping silence detection - no audio tracks available. This may be due to browser permissions or Google Meet audio sharing settings.');
              console.warn('Meeting will rely on presence detection and max duration timeout.');
              return;
            }

            try {
              const audioContext = new AudioContext();
              const mediaSource = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();

              /* Use a value suitable for the given use case of silence detection
                 |
                 |____ Relatively smaller FFT size for faster processing and less sampling
              */
              analyser.fftSize = 256;

              mediaSource.connect(analyser);

              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              
              // Sliding silence period
              let silenceDuration = 0;
              let totalChecks = 0;
              let audioActivitySum = 0;

              // Audio gain/volume
              const silenceThreshold = 10;

              let monitor = true;

              const monitorSilence = () => {
                try {
                  analyser.getByteFrequencyData(dataArray);

                  const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;
                  audioActivitySum += audioActivity;
                  totalChecks++;

                  if (audioActivity < silenceThreshold) {
                    silenceDuration += 100; // Check every 100ms
                    if (silenceDuration >= inactivityLimit) {
                        console.warn('Detected silence in Google Meet and ending the recording on team:', userId, teamId);
                        console.log('Silence detection stats - Avg audio activity:', (audioActivitySum / totalChecks).toFixed(2), 'Checks performed:', totalChecks);
                        monitor = false;
                        stopTheRecording();
                    }
                  } else {
                    silenceDuration = 0;
                  }

                  if (monitor) {
                    // Recursively queue the next check
                    setTimeout(monitorSilence, 100);
                  }
                } catch (error) {
                  console.error('Error in silence monitoring:', error);
                  console.warn('Silence detection failed - will rely on presence detection and max duration timeout.');
                  // Stop monitoring on error
                  monitor = false;
                }
              };

              // Go silence monitor
              monitorSilence();
            } catch (error) {
              console.error('Failed to initialize silence detection:', error);
              console.warn('Silence detection initialization failed - will rely on presence detection and max duration timeout.');
            }
          };

          /**
           * Perpetual checks for inactivity detection
           */
          inactivityParticipantDetectionTimeout = setTimeout(() => {
            detectLoneParticipantResilient();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          inactivitySilenceDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          const detectModalsAndDismiss = () => {
            let dismissModalErrorCount = 0;
            const maxDismissModalErrorCount = 10;
            dismissModalsInterval = setInterval(() => {
              try {
                const buttons = document.querySelectorAll('button');
                const dismissButtons = Array.from(buttons).filter((button) => button?.offsetParent !== null && button?.innerText?.includes('Got it'));
                if (dismissButtons.length > 0) {
                  console.log('Found "Got it" button, clicking it...', dismissButtons[0]);
                  dismissButtons[0].click();
                }
              } catch(error) {
                lastDimissError = error;
                dismissModalErrorCount += 1;
                if (dismissModalErrorCount > maxDismissModalErrorCount) {
                  console.error(`Failed to detect and dismiss "Got it" modals ${maxDismissModalErrorCount} times, will stop trying...`);
                  clearInterval(dismissModalsInterval);
                }
              }
            }, 2000);
          };

          const detectMeetingIsOnAValidPage = () => {
            // Simple check to verify we're still on a supported Google Meet page
            const isOnValidGoogleMeetPage = () => {
              try {
                // Check if we're still on a Google Meet URL
                const currentUrl = window.location.href;
                if (!currentUrl.includes('meet.google.com')) {
                  console.warn('No longer on Google Meet page - URL changed to:', currentUrl);
                  return false;
                }

                const currentBodyText = document.body.innerText;
                if (currentBodyText.includes('You\'ve been removed from the meeting')) {
                  console.warn('Bot was removed from the meeting - ending recording on team:', userId, teamId);
                  return false;
                }

                if (currentBodyText.includes('No one responded to your request to join the call')) {
                  console.warn('Bot was not admitted to the meeting - ending recording on team:', userId, teamId);
                  return false;
                }

                // Check for basic Google Meet UI elements
                const hasMeetElements = document.querySelector('button[aria-label="People"]') !== null ||
                                      document.querySelector('button[aria-label="Leave call"]') !== null;

                if (!hasMeetElements) {
                  console.warn('Google Meet UI elements not found - page may have changed state');
                  return false;
                }

                return true;
              } catch (error) {
                console.error('Error checking page validity:', error);
                return false;
              }
            };

            // check if we're still on a valid Google Meet page
            isOnValidGoogleMeetPageInterval = setInterval(() => {
              if (!isOnValidGoogleMeetPage()) {
                console.log('Google Meet page state changed - ending recording on team:', userId, teamId);
                clearInterval(isOnValidGoogleMeetPageInterval);
                stopTheRecording();
              }
            }, 10000);
          };

          detectModalsAndDismiss();

          detectMeetingIsOnAValidPage();
          
          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
      { 
        teamId,
        duration,
        inactivityLimit,
        userId,
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType
      }
    );
  
    this._logger.info('Waiting for recording duration', config.maxRecordingDuration, 'minutes...');
    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    waitingPromise.promise.then(async () => {
      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;
  }
}
