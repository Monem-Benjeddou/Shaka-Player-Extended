/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */


goog.provide('shaka.ui.SeekBar');

goog.require('shaka.ads.Utils');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.ui.Constants');
goog.require('shaka.ui.Locales');
goog.require('shaka.ui.Localization');
goog.require('shaka.ui.RangeElement');
goog.require('shaka.ui.Utils');
goog.require('shaka.util.Dom');
goog.require('shaka.util.Error');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.Networking');
goog.require('shaka.util.Timer');
goog.requireType('shaka.ui.Controls');
goog.require('shaka.util.Platform');


/**
 * @extends {shaka.ui.RangeElement}
 * @implements {shaka.extern.IUISeekBar}
 * @final
 * @export
 */
shaka.ui.SeekBar = class extends shaka.ui.RangeElement {
  /**
   * @param {!HTMLElement} parent
   * @param {!shaka.ui.Controls} controls
   */
  constructor(parent, controls) {
    super(parent, controls,
        [
          'shaka-seek-bar-container',
        ],
        [
          'shaka-seek-bar',
          'shaka-no-propagation',
          'shaka-show-controls-on-mouse-over',
        ]);

    /** @private {!HTMLElement} */
    this.adMarkerContainer_ = shaka.util.Dom.createHTMLElement('div');
    this.adMarkerContainer_.classList.add('shaka-ad-markers');
    this.container.insertBefore(
        this.adMarkerContainer_, this.container.childNodes[0]);
    /** @private {!HTMLElement} */
    this.chaptersContainer_ = shaka.util.Dom.createHTMLElement('div');
    this.chaptersContainer_.classList.add('shaka-chapter-container');
    this.container.insertBefore(
        this.chaptersContainer_, this.container.childNodes[0]);
    /** @private {!shaka.extern.UIConfiguration} */
    this.config_ = this.controls.getConfig();

    /**
     * This timer is used to introduce a delay between the user scrubbing across
     * the seek bar and the seek being sent to the player.
     *
     * @private {shaka.util.Timer}
     */
    this.seekTimer_ = new shaka.util.Timer(() => {
      let newCurrentTime = this.getValue();
      if (!this.player.isLive()) {
        if (newCurrentTime == this.video.duration) {
          newCurrentTime -= 0.001;
        }
      }
      this.video.currentTime = newCurrentTime;
    });


    /**
     * The timer is activated for live content and checks if
     * new ad breaks need to be marked in the current seek range.
     *
     * @private {shaka.util.Timer}
     */
    this.adBreaksTimer_ = new shaka.util.Timer(() => {
      this.markAdBreaks_();
    });


    /**
     * When user is scrubbing the seek bar - we should pause the video - see
     * https://github.com/google/shaka-player/pull/2898#issuecomment-705229215
     * but will conditionally pause or play the video after scrubbing
     * depending on its previous state
     *
     * @private {boolean}
     */
    this.wasPlaying_ = false;


    /** @private {!HTMLElement} */
    this.thumbnailContainer_ = shaka.util.Dom.createHTMLElement('div');
    this.thumbnailContainer_.id = 'shaka-player-ui-thumbnail-container';

    /** @private {!HTMLImageElement} */
    this.thumbnailImage_ = /** @type {!HTMLImageElement} */ (
      shaka.util.Dom.createHTMLElement('img'));
    this.thumbnailImage_.id = 'shaka-player-ui-thumbnail-image';
    this.thumbnailImage_.draggable = false;

    /** @private {!HTMLElement} */
    this.thumbnailTime_ = shaka.util.Dom.createHTMLElement('div');
    this.thumbnailTime_.id = 'shaka-player-ui-thumbnail-time';

    this.thumbnailContainer_.appendChild(this.thumbnailImage_);
    this.thumbnailContainer_.appendChild(this.thumbnailTime_);
    this.container.appendChild(this.thumbnailContainer_);

    this.timeContainer_ = shaka.util.Dom.createHTMLElement('div');
    this.timeContainer_.id = 'shaka-player-ui-time-container';
    this.container.appendChild(this.timeContainer_);

    /**
     * @private {?shaka.extern.Thumbnail}
     */
    this.lastThumbnail_ = null;
    /**
     * @private
     */
    this.chapters_ = this.player.getChapters('en');
    /**
     * @private {?shaka.net.NetworkingEngine.PendingRequest}
     */
    this.lastThumbnailPendingRequest_ = null;

    /**
     * True if the bar is moving due to touchscreen or keyboard events.
     *
     * @private {boolean}
     */
    this.isMoving_ = false;

    /**
     * The timer is activated to hide the thumbnail.
     *
     * @private {shaka.util.Timer}
     */
    this.hideThumbnailTimer_ = new shaka.util.Timer(() => {
      this.hideThumbnail_();
    });

    /** @private {!Array.<!shaka.extern.AdCuePoint>} */
    this.adCuePoints_ = [];

    this.eventManager.listen(this.localization,
        shaka.ui.Localization.LOCALE_UPDATED,
        () => this.updateAriaLabel_());

    this.eventManager.listen(this.localization,
        shaka.ui.Localization.LOCALE_CHANGED,
        () => this.updateAriaLabel_());

    this.eventManager.listen(
        this.adManager, shaka.ads.Utils.AD_STARTED, () => {
          if (!this.shouldBeDisplayed_()) {
            shaka.ui.Utils.setDisplay(this.container, false);
          }
        });

    this.eventManager.listen(
        this.adManager, shaka.ads.Utils.AD_STOPPED, () => {
          if (this.shouldBeDisplayed_()) {
            shaka.ui.Utils.setDisplay(this.container, true);
          }
        });

    this.eventManager.listen(
        this.adManager, shaka.ads.Utils.CUEPOINTS_CHANGED, (e) => {
          this.adCuePoints_ = (e)['cuepoints'];
          this.onAdCuePointsChanged_();
        });

    this.eventManager.listen(
        this.player, 'unloading', () => {
          this.adCuePoints_ = [];
          this.onAdCuePointsChanged_();
          if (this.lastThumbnailPendingRequest_) {
            this.lastThumbnailPendingRequest_.abort();
            this.lastThumbnailPendingRequest_ = null;
          }
          this.lastThumbnail_ = null;
          this.hideThumbnail_();
          this.hideTime_();
        });

    this.eventManager.listen(this.bar, 'mousemove', (event) => {
      const rect = this.bar.getBoundingClientRect();
      const min = parseFloat(this.bar.min);
      const max = parseFloat(this.bar.max);
      const mousePosition = event.clientX - rect.left;
      const scale = (max - min) / rect.width;
      const value = Math.round(min + scale * mousePosition);
      if (!this.player.getImageTracks().length) {
        this.hideThumbnail_();
        this.showTime_(mousePosition, value);
        return;
      }
      this.hideTime_();
      this.showThumbnail_(mousePosition, value);
    });
    this.eventManager.listen(this.container, 'mouseleave', () => {
      this.hideTime_();
      this.hideThumbnailTimer_.stop();
      this.hideThumbnailTimer_.tickAfter(/* seconds= */ 0.25);
    });
    // Initialize seek state and label.
    this.setValue(this.video.currentTime);
    this.update();
    this.updateAriaLabel_();

    if (this.ad) {
      // There was already an ad.
      shaka.ui.Utils.setDisplay(this.container, false);
    }
  }

  /** @override */
  release() {
    if (this.seekTimer_) {
      this.seekTimer_.stop();
      this.seekTimer_ = null;
      this.adBreaksTimer_.stop();
      this.adBreaksTimer_ = null;
    }

    super.release();
  }

  /**
   * Detects if this is a mobile platform, in case you want to choose a
   * different UI configuration on mobile devices.
   *
   * @return {boolean}
   * @export
   */
  isMobile() {
    return shaka.util.Platform.isMobile();
  }

  /**
   * Called by the base class when user interaction with the input element
   * begins.
   *
   * @override
   */
  onChangeStart() {
    // console.log(`Interaction started: videopaused = ${this.video}`);
    // this.wasPlaying_ = !this.video.paused;
    // console.log(`Interaction started: wasPlaying_= ${this.wasPlaying_}`);
    // console.log('Video paused for scrubbing.');
    this.wasPlaying_ = !this.video.paused;
    this.video.pause();
    this.isMoving_ = true;
    /*     this.controls.setSeeking(true);
    this.video.pause();
    console.log('Video paused for scrubbing.');
    this.hideThumbnailTimer_.stop();
    this.isMoving_ = true;
    console.log(`Seek interaction started: isMoving_=${this.isMoving_}`); */
  }

  /**
   * Update the video element's state to match the input element's state.
   * Called by the base class when the input element changes.
   *
   * @override
   */
  onChange() {
    if (!this.video.duration) {
      console.log('Seek bar change ignored: Video duration not available.');
      return;
    }

    console.log('Seek bar changed.');
    this.update(); // Immediate UI update.

    this.seekTimer_.tickAfter(/* seconds= */ 0.125);

    if (this.player.getImageTracks().length) {
      const min = parseFloat(this.bar.min);
      const max = parseFloat(this.bar.max);
      const rect = this.bar.getBoundingClientRect();
      const value = Math.round(this.getValue());
      const scale = (max - min) / rect.width;
      const position = (value - min) / scale;

      console.log(`Thumbnail displayed at position:`+
        ` ${position}, value: ${value}`);
      this.showThumbnail_(position, value);
    } else {
      console.log('No image tracks available. Hiding thumbnail.');
      this.hideThumbnail_();
    }
    this.isMoving_ = true;
  }

  /**
   * Called by the base class when user interaction with the input element
   * ends.
   *
   * @override
   */
  onChangeEnd() {
    console.log('User stopped interacting with seek bar.');
    this.seekTimer_.tickNow();
    this.controls.setSeeking(false);

    if (this.isMobile()) {
      if (this.isMoving_) {
        console.log('Ending seek bar interaction on mobile.');
        this.isMoving_ = false;

        if (this.wasPlaying_) {
          console.log('Resuming video playback.');
          this.video.play();
        } else {
          console.log('Video was initially paused; not resuming.');
        }
      }
    } else {
      console.log('Desktop interaction; resuming video playback.');
      this.video.play();
    }

    // Hide the thumbnail after scrubbing completes
    this.hideThumbnailTimer_.stop();
    this.hideThumbnailTimer_.tickAfter(/* seconds= */ 0.25);
  }

  /**
   * @override
  */
  isShowing() {
    // It is showing by default, so it is hidden if shaka-hidden is in the list.
    return !this.container.classList.contains('shaka-hidden');
  }

  /**
   * @override
   */
  update() {
    const seekRange = this.player.seekRange();

    this.setRange(seekRange.start, seekRange.end);
    if (this.chapters_) {
      this.container.style.background = 'transparent';
      this.setChapters_();
    }
    if (!this.shouldBeDisplayed_()) {
      shaka.ui.Utils.setDisplay(this.container, false);
    } else {
      shaka.ui.Utils.setDisplay(this.container, true);
    }
  }

  /**
   * @private
   */
  setChapters_() {
    const videoDuration = this.video.duration;
    const gapWidthPercentage = 1;

    if (this.chaptersContainer_) {
      let cumulativeLeftOffset = 0;

      for (let i = 0; i < this.chapters_.length; i++) {
        const chapter = this.chapters_[i];
        const chapterId = `shaka-chapter-${i}`;

        let chapterDiv = document.getElementById(chapterId);
        if (!chapterDiv) {
          chapterDiv = shaka.util.Dom.createHTMLElement('div');
          chapterDiv.id = chapterId;
          chapterDiv.classList.add('shaka-chapter');
          this.chaptersContainer_.appendChild(chapterDiv);

          chapterDiv.addEventListener('mouseenter',
              (e) => this.showTooltip_(e, chapter.title));
          chapterDiv.addEventListener('mouseleave', () => this.hideTooltip_());
        }

        const chapterStartFraction = chapter.startTime / videoDuration;
        const chapterEndFraction = chapter.endTime / videoDuration;
        const chapterWidthFraction = chapterEndFraction - chapterStartFraction;

        const adjustedWidth = chapterWidthFraction *
          (100 - (gapWidthPercentage * (this.chapters_.length - 1)));
        const adjustedLeft = cumulativeLeftOffset;

        chapterDiv.style.left = `${adjustedLeft}%`;
        chapterDiv.style.width = `${adjustedWidth}%`;
        chapterDiv.style.backgroundColor = 'rgba(230, 229, 229, 0.64)';
        chapterDiv.style.position = 'absolute';
        chapterDiv.style.height = '100%';

        // Update cumulative offset for the next chapter, adding the gap width
        cumulativeLeftOffset += adjustedWidth + gapWidthPercentage;
      }
    }
  }

  /**
   * @private
   */
  showTooltip_(event, title) {
    let tooltip = document.getElementById('chapter-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'chapter-tooltip';
      tooltip.classList.add('shaka-chapter-tooltip');
      document.body.appendChild(tooltip);
    }

    tooltip.textContent = title;
    tooltip.style.left = `${event.pageX + 10}px`;
    tooltip.style.top = `${event.pageY - 30}px`;
    tooltip.classList.add('show');
  }

  /**
   * @private
   */
  hideTooltip_() {
    const tooltip = document.getElementById('chapter-tooltip');
    if (tooltip) {
      tooltip.classList.remove('show');
    }
  }

  /**
   * @private
   */
  markAdBreaks_() {
    if (!this.adCuePoints_.length) {
      this.adMarkerContainer_.style.background = 'transparent';
      this.adBreaksTimer_.stop();
      return;
    }

    const seekRange = this.player.seekRange();
    const seekRangeSize = seekRange.end - seekRange.start;
    const gradient = ['to right'];
    let pointsAsFractions = [];
    const adBreakColor = this.config_.seekBarColors.adBreaks;
    let postRollAd = false;
    for (const point of this.adCuePoints_) {
      // Post-roll ads are marked as starting at -1 in CS IMA ads.
      if (point.start == -1 && !point.end) {
        postRollAd = true;
        continue;
      }
      // Filter point within the seek range. For points with no endpoint
      // (client side ads) check that the start point is within range.
      if ((!point.end && point.start >= seekRange.start) ||
          (typeof point.end == 'number' && point.end > seekRange.start)) {
        const startDist =
            Math.max(point.start, seekRange.start) - seekRange.start;
        const startFrac = (startDist / seekRangeSize) || 0;
        // For points with no endpoint assume a 1% length: not too much,
        // but enough to be visible on the timeline.
        let endFrac = startFrac + 0.01;
        if (point.end) {
          const endDist = point.end - seekRange.start;
          endFrac = (endDist / seekRangeSize) || 0;
        }

        pointsAsFractions.push({
          start: startFrac,
          end: endFrac,
        });
      }
    }

    pointsAsFractions = pointsAsFractions.sort((a, b) => {
      return a.start - b.start;
    });

    for (const point of pointsAsFractions) {
      gradient.push(this.makeColor_('transparent', point.start));
      gradient.push(this.makeColor_(adBreakColor, point.start));
      gradient.push(this.makeColor_(adBreakColor, point.end));
      gradient.push(this.makeColor_('transparent', point.end));
    }

    if (postRollAd) {
      gradient.push(this.makeColor_('transparent', 0.99));
      gradient.push(this.makeColor_(adBreakColor, 0.99));
    }
    this.adMarkerContainer_.style.background =
            'linear-gradient(' + gradient.join(',') + ')';
  }


  /**
   * @param {string} color
   * @param {number} fract
   * @return {string}
   * @private
   */
  makeColor_(color, fract) {
    return color + ' ' + (fract * 100) + '%';
  }


  /**
   * @private
   */
  onAdCuePointsChanged_() {
    const action = () => {
      this.markAdBreaks_();
      const seekRange = this.player.seekRange();
      const seekRangeSize = seekRange.end - seekRange.start;
      const minSeekBarWindow =
          shaka.ui.Constants.MIN_SEEK_WINDOW_TO_SHOW_SEEKBAR;
      // Seek range keeps changing for live content and some of the known
      // ad breaks might not be in the seek range now, but get into
      // it later.
      // If we have a LIVE seekable content, keep checking for ad breaks
      // every second.
      if (this.player.isLive() && seekRangeSize > minSeekBarWindow) {
        this.adBreaksTimer_.tickEvery(/* seconds= */ 0.25);
      }
    };
    if (this.player.isFullyLoaded()) {
      action();
    } else {
      this.eventManager.listenOnce(this.player, 'loaded', action);
    }
  }


  /**
   * @return {boolean}
   * @private
   */
  shouldBeDisplayed_() {
    // The seek bar should be hidden when the seek window's too small or
    // there's an ad playing.
    const seekRange = this.player.seekRange();
    const seekRangeSize = seekRange.end - seekRange.start;

    if (this.player.isLive() &&
        (seekRangeSize < shaka.ui.Constants.MIN_SEEK_WINDOW_TO_SHOW_SEEKBAR ||
        !isFinite(seekRangeSize))) {
      return false;
    }

    return this.ad == null || !this.ad.isLinear();
  }

  /** @private */
  updateAriaLabel_() {
    this.bar.ariaLabel = this.localization.resolve(shaka.ui.Locales.Ids.SEEK);
  }

  /** @private */
  showTime_(pixelPosition, value) {
    const offsetTop = -10;
    const width = this.timeContainer_.clientWidth;
    const height = 20;
    this.timeContainer_.style.width = 'auto';
    this.timeContainer_.style.height = height + 'px';
    this.timeContainer_.style.top = -(height - offsetTop) + 'px';
    const leftPosition = Math.min(this.bar.offsetWidth - width,
        Math.max(0, pixelPosition - (width / 2)));
    this.timeContainer_.style.left = leftPosition + 'px';
    this.timeContainer_.style.visibility = 'visible';
    const seekRange = this.player.seekRange();
    if (this.player.isLive()) {
      const totalSeconds = seekRange.end - value;
      if (totalSeconds < 1) {
        this.timeContainer_.textContent =
          this.localization.resolve(shaka.ui.Locales.Ids.LIVE);
      } else {
        this.timeContainer_.textContent =
          '-' + this.timeFormatter_(totalSeconds);
      }
    } else {
      const totalSeconds = value - seekRange.start;
      this.timeContainer_.textContent = this.timeFormatter_(totalSeconds);
    }
  }

  /**
   * @private
   */
  async showThumbnail_(pixelPosition, value) {
    const thumbnailTrack = this.getThumbnailTrack_();
    if (!thumbnailTrack) {
      this.hideThumbnail_();
      return;
    }

    if (value < 0) {
      value = 0;
    }

    const seekRange = this.player.seekRange();
    const playerValue = Math.max(Math.ceil(seekRange.start),
        Math.min(Math.floor(seekRange.end), value));

    const thumbnail =
      await this.player.getThumbnails(thumbnailTrack.id, playerValue);
    if (!thumbnail || !thumbnail.uris.length) {
      this.hideThumbnail_();
      return;
    }

    const totalSeconds =
      this.player.isLive() ? seekRange.end - value : value - seekRange.start;

    // Find the current chapter based on the value
    const currentChapter = this.chapters_.find((chapter) => {
      return totalSeconds >=
        chapter.startTime && totalSeconds <= chapter.endTime;
    });

    if (currentChapter) {
      this.thumbnailTime_.textContent = currentChapter.title;
    } else {
      if (this.player.isLive()) {
        if (totalSeconds < 1) {
          this.thumbnailTime_.textContent =
            this.localization.resolve(shaka.ui.Locales.Ids.LIVE);
        } else {
          this.thumbnailTime_.textContent =
            '-' + this.timeFormatter_(totalSeconds);
        }
      } else {
        this.thumbnailTime_.textContent = this.timeFormatter_(value);
      }
    }

    const offsetTop = -10;
    const width = this.thumbnailContainer_.clientWidth;
    let height = Math.floor(width * 9 / 16);
    this.thumbnailContainer_.style.height = height + 'px';
    this.thumbnailContainer_.style.top = -(height - offsetTop) + 'px';
    const leftPosition = Math.min(this.bar.offsetWidth - width,
        Math.max(0, pixelPosition - (width / 2)));
    this.thumbnailContainer_.style.left = leftPosition + 'px';
    this.thumbnailContainer_.style.visibility = 'visible';

    let uri = thumbnail.uris[0].split('#xywh=')[0];
    if (!this.lastThumbnail_ ||
      uri !== this.lastThumbnail_.uris[0].split('#xywh=')[0] ||
      thumbnail.segment.getStartByte() !=
        this.lastThumbnail_.segment.getStartByte() ||
      thumbnail.segment.getEndByte() !=
        this.lastThumbnail_.segment.getEndByte()) {
      this.lastThumbnail_ = thumbnail;

      if (this.lastThumbnailPendingRequest_) {
        this.lastThumbnailPendingRequest_.abort();
        this.lastThumbnailPendingRequest_ = null;
      }

      if (thumbnailTrack.codecs == 'mjpg' || uri.startsWith('offline:')) {
        this.thumbnailImage_.src = shaka.ui.SeekBar.Transparent_Image_;
        try {
          const requestType = shaka.net.NetworkingEngine.RequestType.SEGMENT;
          const type =
            shaka.net.NetworkingEngine.AdvancedRequestType.MEDIA_SEGMENT;
          const request = shaka.util.Networking.createSegmentRequest(
              thumbnail.segment.getUris(),
              thumbnail.segment.getStartByte(),
              thumbnail.segment.getEndByte(),
              this.player.getConfiguration().streaming.retryParameters,
          );
          this.lastThumbnailPendingRequest_ = this.player.getNetworkingEngine()
              .request(requestType, request, {type});
          const response = await this.lastThumbnailPendingRequest_.promise;
          this.lastThumbnailPendingRequest_ = null;

          if (thumbnailTrack.codecs == 'mjpg') {
            const parser = new shaka.util.Mp4Parser()
                .box('mdat', shaka.util.Mp4Parser.allData((data) => {
                  const blob = new Blob([data], {type: 'image/jpeg'});
                  uri = URL.createObjectURL(blob);
                }));
            parser.parse(response.data, /* partialOkay= */ false);
          } else {
            const mimeType = thumbnailTrack.mimeType || 'image/jpeg';
            const blob = new Blob([response.data], {type: mimeType});
            uri = URL.createObjectURL(blob);
          }
        } catch (error) {
          if (error.code == shaka.util.Error.Code.OPERATION_ABORTED) {
            return;
          }
          throw error;
        }
      }

      try {
        this.thumbnailContainer_.removeChild(this.thumbnailImage_);
      } catch (e) {
        // The image is not a child
      }

      this.thumbnailImage_ = /** @type {!HTMLImageElement} */ (
        shaka.util.Dom.createHTMLElement('img'));
      this.thumbnailImage_.id = 'shaka-player-ui-thumbnail-image';
      this.thumbnailImage_.draggable = false;
      this.thumbnailImage_.src = uri;
      this.thumbnailImage_.onload = () => {
        if (uri.startsWith('blob:')) {
          URL.revokeObjectURL(uri);
        }
      };
      this.thumbnailContainer_.insertBefore(this.thumbnailImage_,
          this.thumbnailContainer_.firstChild);
    }

    const scale = width / thumbnail.width;
    if (thumbnail.imageHeight) {
      this.thumbnailImage_.height = thumbnail.imageHeight;
    } else if (!thumbnail.sprite) {
      this.thumbnailImage_.style.height = '100%';
      this.thumbnailImage_.style.objectFit = 'contain';
    }

    if (thumbnail.imageWidth) {
      this.thumbnailImage_.width = thumbnail.imageWidth;
    } else if (!thumbnail.sprite) {
      this.thumbnailImage_.style.width = '100%';
      this.thumbnailImage_.style.objectFit = 'contain';
    }

    this.thumbnailImage_.style.left = '-' + scale * thumbnail.positionX + 'px';
    this.thumbnailImage_.style.top = '-' + scale * thumbnail.positionY + 'px';
    this.thumbnailImage_.style.transform = 'scale(' + scale + ')';
    this.thumbnailImage_.style.transformOrigin = 'left top';

    // Update container height and top
    height = Math.floor(width * thumbnail.height / thumbnail.width);
    this.thumbnailContainer_.style.height = height + 'px';
    this.thumbnailContainer_.style.top = -(height - offsetTop) + 'px';
  }


  /**
   * @return {?shaka.extern.Track} The thumbnail track.
   * @private
   */
  getThumbnailTrack_() {
    const imageTracks = this.player.getImageTracks();
    if (!imageTracks.length) {
      return null;
    }
    const mimeTypesPreference = [
      'image/avif',
      'image/webp',
      'image/jpeg',
      'image/png',
      'image/svg+xml',
    ];
    for (const mimeType of mimeTypesPreference) {
      const estimatedBandwidth = this.player.getStats().estimatedBandwidth;
      const bestOptions = imageTracks.filter((track) => {
        return track.mimeType.toLowerCase() === mimeType &&
            track.bandwidth < estimatedBandwidth * 0.01;
      }).sort((a, b) => {
        return b.bandwidth - a.bandwidth;
      });
      if (bestOptions && bestOptions.length) {
        return bestOptions[0];
      }
    }
    const mjpgTrack = imageTracks.find((track) => {
      return track.mimeType == 'application/mp4' && track.codecs == 'mjpg';
    });
    return mjpgTrack || imageTracks[0];
  }


  /**
   * @private
   */
  hideThumbnail_() {
    this.thumbnailContainer_.style.visibility = 'hidden';
    this.thumbnailTime_.textContent = '';
  }


  /**
   * @private
   */
  hideTime_() {
    this.timeContainer_.style.visibility = 'hidden';
  }


  /**
   * @param {number} totalSeconds
   * @private
   */
  timeFormatter_(totalSeconds) {
    const secondsNumber = Math.round(totalSeconds);
    const hours = Math.floor(secondsNumber / 3600);
    let minutes = Math.floor((secondsNumber - (hours * 3600)) / 60);
    let seconds = secondsNumber - (hours * 3600) - (minutes * 60);
    if (seconds < 10) {
      seconds = '0' + seconds;
    }
    if (hours > 0) {
      if (minutes < 10) {
        minutes = '0' + minutes;
      }
      return hours + ':' + minutes + ':' + seconds;
    } else {
      return minutes + ':' + seconds;
    }
  }
};


/**
 * @const {string}
 * @private
 */
shaka.ui.SeekBar.Transparent_Image_ =
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';


/**
 * @implements {shaka.extern.IUISeekBar.Factory}
 * @export
 */

shaka.ui.SeekBar.Factory = class {
  /**
   * Creates a shaka.ui.SeekBar. Use this factory to register the default
   * SeekBar when needed
   *
   * @override
   */
  create(rootElement, controls) {
    return new shaka.ui.SeekBar(rootElement, controls);
  }
};
