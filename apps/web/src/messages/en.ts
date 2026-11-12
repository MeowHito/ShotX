import type { PublicMessages } from './public';

/**
 * English for the public pages (ADR 0011; see messages/public). The consent texts are
 * translations for the DPO to approve: the Thai text is the legal reference.
 */
export const en: PublicMessages = {
  metadata: {
    title: 'ShotX',
    description: 'Event photo delivery: share a link, and guests find their own photos by face.',
    shareDescription: 'See the event photos and find yours by face.',
  },
  publicNav: {
    label: 'Main menu',
    home: 'Home',
    language: 'Language',
    locales: { th: 'ไทย', en: 'English', zh: '中文' },
    localeShort: { th: 'TH', en: 'EN', zh: '中文' },
  },
  common: {
    appName: 'ShotX',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    loading: 'Loading…',
    retry: 'Try again',
    duration: {
      hours: '{count, plural, one {# hour} other {# hours}}',
      minutes: '{count, plural, one {# minute} other {# minutes}}',
    },
  },
  share: {
    expiresAt: 'Link valid until {date}',
    galleryLabel: 'Photos in this link',
    empty: 'No photos in this link yet',
    loadingMore: 'Loading more…',
    loadError: 'Couldn’t load the photos',
    open: 'Open {name}',
    select: 'Select {name}',
    video: 'Video',
    yourPhotos: 'Your photos',
    allPhotos: 'All photos',
    unavailable: {
      title: 'This link has expired',
      body: 'Ask the photographer for a new link.',
      reasons: {
        revoked: 'The photographer has turned this link off.',
        expired: 'This link is past its expiry date.',
        unavailable: 'The photos in this link are no longer available.',
      },
    },
    login: {
      title: 'Sign in to see the photos',
      body: 'The photographer requires sign-in for this link.',
      line: 'Sign in with LINE',
      google: 'Sign in with Google',
      connecting: 'Connecting your account…',
      unavailableTitle: 'Sign-in isn’t available for this link',
      unavailableBody:
        'This link requires sign-in, but sign-in is currently turned off. Please contact the photographer who sent you the link.',
      devLogin: 'Sign in (test mode)',
    },
    password: {
      title: 'This link has a password',
      body: 'Enter the password from the photographer or the organiser.',
      label: 'Password',
      submit: 'View photos',
    },
    faceOnly: {
      title: 'Find your photos',
      body: 'This link shows only the photos you are in. Search with your face to see them.',
      unavailable: 'Face search isn’t available for this link right now. Please try again later.',
    },
    scan: 'Find me by face',
    scanAgain: 'Search by face again',
    withdraw: 'Withdraw consent to use my face data',
    withdrawn: 'Consent withdrawn and your search results deleted.',
  },
  consent: {
    version: 'Version {version}',
    accept: 'Accept and start',
    acceptDeletion: 'Accept and take a selfie',
    decline: 'Decline',
    mustCheck: 'Please tick the box to agree before you start.',
    details: 'Read the details',
    translationNote: 'This is a translation. The Thai text is the legal reference.',
    policies: {
      face_search: {
        '2026-11-11b': {
          title: 'Find your photos by face',
          points: {
            purpose: 'We use a photo of your face only to find the photos of you in this link.',
            noStorage: 'Your face photo is not saved. It is deleted right after the search.',
            results:
              'Your results stay available to download for {ttl} after your latest search, then they are deleted automatically.',
            processor:
              'Processing happens on servers we rent in Malaysia. Nothing is sent to another company’s face analysis service.',
          },
          details: {
            sensitive:
              'A face image is biometric data, which is sensitive personal data under section 26 of Thailand’s Personal Data Protection Act B.E. 2562 (2019). That is why we ask for your consent first.',
            selfie:
              'Your selfie is processed in memory to compare it with the faces in this link’s photos, then deleted immediately. Your selfie is not saved on your device or in our system, and it is not used for any other purpose.',
            index:
              'To make search possible, the photographer has the system index the faces of the people in this link’s photos. This face index expires on the schedule the photographer sets and is then deleted automatically.',
            processor:
              'Faces are compared on our own servers, rented from a server provider and located in Kuala Lumpur, Malaysia. No face image is sent to an outside face analysis service.',
            transfer:
              'Face data is therefore sent to and stored outside Thailand, in Malaysia. This is a transfer of personal data abroad under section 28 of Thailand’s Personal Data Protection Act B.E. 2562 (2019).',
            backups:
              'Backups we make ourselves do not include face data and are encrypted. The server provider may keep backup copies of the whole server on its own schedule.',
            rights:
              'You can withdraw your consent at any time from this link’s page, and you can ask for your face data to be deleted from the photographer’s search system on the “Delete my face” page.',
            contact:
              'If you have questions about the photos or data in this link, please contact the photographer or the event organiser.',
          },
          checkbox: 'I agree to the use of my face photo to find my photos',
        },
        // 2026-11-11b without the pointer to the unlinked deletion page (ADR 0011): ask the
        // photographer or organiser instead. DPO review pending.
        '2026-11-12': {
          title: 'Find your photos by face',
          points: {
            purpose: 'We use a photo of your face only to find the photos of you in this link.',
            noStorage: 'Your face photo is not saved. It is deleted right after the search.',
            results:
              'Your results stay available to download for {ttl} after your latest search, then they are deleted automatically.',
            processor:
              'Processing happens on servers we rent in Malaysia. Nothing is sent to another company’s face analysis service.',
          },
          details: {
            sensitive:
              'A face image is biometric data, which is sensitive personal data under section 26 of Thailand’s Personal Data Protection Act B.E. 2562 (2019). That is why we ask for your consent first.',
            selfie:
              'Your selfie is processed in memory to compare it with the faces in this link’s photos, then deleted immediately. Your selfie is not saved on your device or in our system, and it is not used for any other purpose.',
            index:
              'To make search possible, the system automatically indexes the faces of the people in this link’s photos when the photographer uploads them. The face index expires once no new photo has been uploaded to this event for the period the system sets, and is then deleted automatically.',
            processor:
              'Faces are compared on our own servers, rented from a server provider and located in Kuala Lumpur, Malaysia. No face image is sent to an outside face analysis service.',
            transfer:
              'Face data is therefore sent to and stored outside Thailand, in Malaysia. This is a transfer of personal data abroad under section 28 of Thailand’s Personal Data Protection Act B.E. 2562 (2019).',
            backups:
              'Backups we make ourselves do not include face data and are encrypted. The server provider may keep backup copies of the whole server on its own schedule.',
            rights:
              'You can withdraw your consent at any time from this link’s page, and you can ask for your face data to be deleted by contacting the photographer or the event organiser.',
            contact:
              'If you have questions about the photos or data in this link, please contact the photographer or the event organiser.',
          },
          checkbox: 'I agree to the use of my face photo to find my photos',
        },
      },
      face_deletion: {
        '2026-11-11b': {
          title: 'Consent to use your face data to delete your face',
          intro:
            'To delete your face from the search system, we need a photo of your face to find the matching faces. A face image is biometric data, which is sensitive personal data under section 26 of Thailand’s Personal Data Protection Act B.E. 2562 (2019), so we ask for your consent first.',
          points: {
            purpose:
              'We use your selfie only to find your face in all of this photographer’s photos and remove the faces found from the search system, and for no other purpose.',
            noStorage:
              'Your selfie is processed in memory and deleted immediately. Your selfie is not saved on your device or in our system.',
            results:
              'You are only told how many faces were found; no photos are shown. The photos stay as they are, but the deleted faces can no longer be found by face search. This cannot be undone.',
            processor:
              'Faces are compared on our own servers, rented from a server provider and located in Kuala Lumpur, Malaysia. No face image is sent to an outside face analysis service.',
            transfer:
              'This means face data is sent to and stored outside Thailand, in Malaysia: a transfer of personal data abroad under section 28 of Thailand’s Personal Data Protection Act B.E. 2562 (2019). Your selfie is sent for comparison and deleted immediately; the face index of this photographer’s photos is stored there until it is deleted or expires. Backups we make ourselves do not include face data and are encrypted. The server provider may keep backup copies of the whole server on its own schedule.',
            withdraw:
              'You can withdraw your consent at any time. Withdrawing does not bring deleted faces back into the search system.',
          },
          checkbox:
            'I have read the above and agree to the use of my face photo to find and delete my face',
        },
        // 2026-11-11b without the pointer to the unlinked deletion page (ADR 0011): ask the
        // photographer or organiser instead. DPO review pending.
        '2026-11-12': {
          title: 'Consent to use your face data to delete your face',
          intro:
            'To delete your face from the search system, we need a photo of your face to find the matching faces. A face image is biometric data, which is sensitive personal data under section 26 of Thailand’s Personal Data Protection Act B.E. 2562 (2019), so we ask for your consent first.',
          points: {
            purpose:
              'We use your selfie only to find your face in all of this photographer’s photos and remove the faces found from the search system, and for no other purpose.',
            noStorage:
              'Your selfie is processed in memory and deleted immediately. Your selfie is not saved on your device or in our system.',
            results:
              'You are only told how many faces were found; no photos are shown. The photos stay as they are, but the deleted faces can no longer be found by face search. This cannot be undone.',
            processor:
              'Faces are compared on our own servers, rented from a server provider and located in Kuala Lumpur, Malaysia. No face image is sent to an outside face analysis service.',
            transfer:
              'This means face data is sent to and stored outside Thailand, in Malaysia: a transfer of personal data abroad under section 28 of Thailand’s Personal Data Protection Act B.E. 2562 (2019). Your selfie is sent for comparison and deleted immediately; the face index of this photographer’s photos is stored there until it is deleted or expires. Backups we make ourselves do not include face data and are encrypted. The server provider may keep backup copies of the whole server on its own schedule.',
            withdraw:
              'You can withdraw your consent at any time. Withdrawing does not bring deleted faces back into the search system.',
          },
          checkbox:
            'I have read the above and agree to the use of my face photo to find and delete my face',
        },
      },
    },
  },
  capture: {
    title: 'Take a selfie',
    captchaLabel: 'Confirm you are not a robot',
    captchaRetry: 'Try the check again',
    captchaVerifying: 'Confirmed, sending your photo again…',
    notStored:
      'Your selfie is used for this search only. It is not saved on your device or in our system.',
    openCamera: 'Open camera',
    takePhoto: 'Take photo',
    useCameraApp: 'Take a photo with the camera',
    chooseFromGallery: 'Choose from photos',
    cameraBlocked:
      'The camera can’t open on this page. Tap the button below to use your phone’s camera instead.',
    inAppHint:
      'If you opened this from LINE or Facebook and the camera doesn’t work, open the link in your browser (Safari or Chrome).',
    preview: 'Front camera preview',
    checking: 'Checking your photo…',
    retake: 'Take again',
    issues: {
      unreadable: 'This photo can’t be read.',
      noFace: 'No face found in the photo.',
      multipleFaces: 'More than one face found.',
      tooSmall: 'The face is too small.',
      notFrontal: 'The face isn’t turned to the camera.',
      tooDark: 'The photo is too dark.',
      tooBright: 'The photo is too bright.',
    },
    searching: 'Finding your photos…',
  },
  results: {
    title: 'Face search results',
    found: '{count, plural, one {Found # photo of you} other {Found # photos of you}}',
    selectAll: 'Select all',
    deselectAll: 'Unselect all',
    downloadAll: 'Download all ({count, number})',
    retry: 'Try again',
    strong: 'This is you',
    maybe: 'Might be you',
    groupCount: '{count, plural, one {# photo} other {# photos}}',
    notMe: 'Not me',
    notMeLabel: 'Not me: {name}',
    notMeDone: 'Photo hidden. Thanks for helping us improve the search.',
    none: 'No photos of you were found',
    noFace: 'No face found in the photo. Try again.',
  },
  faceDeletion: {
    title: 'Delete my face',
    intro:
      'Take a selfie to find and delete your face from this photographer’s search system. The photos stay, but nobody can find you by face in this photographer’s photos any more.',
    submit: 'Find and delete my face',
    submitting: 'Finding your face…',
    done: '{count, plural, =0 {Your face wasn’t found in this photographer’s photos} one {Found your face # time; removing it from the search system} other {Found your face # times; removing it from the search system}}',
    doneNote:
      'The faces found are hidden from search right away and permanently deleted within a few minutes.',
    close: 'Back to the link',
    loadError: 'Couldn’t open the face deletion page',
  },
  downloads: {
    download: 'Download',
    downloadSelected: '{count, plural, one {Download # photo} other {Download # photos}}',
    selected: '{count, plural, one {# photo selected} other {# photos selected}}',
    clear: 'Clear selection',
    size: '({size})',
    part: 'Downloading zip {current, number} of {total, number}',
    sizes: {
      web: 'social media size',
      original: 'original files',
    },
    saveToPhotos: 'Save to Photos',
    preparing: 'Preparing photos {done, number}/{total, number}…',
    readyToSave:
      '{count, plural, one {Ready: tap to save # photo} other {Ready: tap to save # photos}}',
    tooManyToSave:
      'You can save up to {max, number} photos to Photos at a time. Use the zip download instead.',
    zipStatus: {
      queued: 'Waiting to prepare the zip file…',
      running: 'Packing photos into a zip file…',
      ready: 'The zip file is ready. Starting the download.',
      failed: 'Couldn’t prepare the zip file. Please try again.',
      expired: 'The zip file has expired. Please download again.',
    },
  },
  lightbox: {
    close: 'Close',
    next: 'Next photo',
    prev: 'Previous photo',
    zoom: 'Zoom',
    download: 'Download this photo',
    downloadShort: 'Download',
    dialog: 'Photo viewer',
    carousel: 'Photos',
    slide: 'Photo',
    loadError: 'This photo can’t be loaded',
  },
  errors: {
    codes: {
      QUOTA_EXCEEDED: 'Not enough storage space.',
      SHARE_EXPIRED: 'This link has expired',
      CONSENT_REQUIRED: 'Please accept the terms for using face data before searching.',
      NO_FACE_DETECTED: 'No face found in the photo.',
      RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
      PAYLOAD_TOO_LARGE: 'What you sent is too large.',
      UNSUPPORTED_FILE_TYPE: 'This file type isn’t supported.',
      FILE_TOO_LARGE: 'The file is too large.',
      VALIDATION_FAILED: 'Something isn’t right. Please check and try again.',
      UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
      FORBIDDEN: 'This account isn’t allowed to do that.',
      NOT_FOUND: 'Not found. It may have been deleted or moved.',
      CONFLICT: 'This has changed. Please refresh and try again.',
      INTERNAL_ERROR: 'Something went wrong on our side. Please try again later.',
      NAME_TAKEN: 'That name is already used here.',
      INVALID_MOVE: 'A folder can’t be moved into itself.',
      FOLDER_DEPTH_EXCEEDED: 'Folders are nested too deep.',
      SUBSCRIPTION_INACTIVE: 'The photographer’s plan isn’t active.',
      UPLOAD_NOT_FOUND: 'Upload not found. Please upload again.',
      UPLOAD_EXPIRED: 'The upload timed out. Please upload again.',
      UPLOAD_PARTS_INVALID: 'The upload is incomplete or damaged. Please upload again.',
      IDEMPOTENCY_KEY_REUSED: 'This request doesn’t match an earlier one. Please try again.',
      LOGIN_REQUIRED: 'You need to sign in to see the photos in this link.',
      PASSWORD_REQUIRED: 'You need the password to see the photos in this link.',
      PASSWORD_INCORRECT: 'Wrong password',
      CONSENT_VERSION_MISMATCH:
        'The consent text for face data has been updated. Please read and accept it again.',
      DOWNLOAD_NOT_ALLOWED: 'The photographer doesn’t allow downloads from this link.',
      ZIP_TOO_LARGE: 'Too many files for one download. Please select fewer.',
      FEATURE_DISABLED: 'This feature isn’t available yet.',
      FACE_SEARCH_UNAVAILABLE: 'Face search isn’t available for this link.',
      PLAN_NOT_FOUND: 'This plan isn’t available.',
      PLAN_CHANGE_INVALID: 'This plan change isn’t possible right now.',
      CHECKOUT_PENDING: 'A payment is still pending.',
      CHECKOUT_EXPIRED: 'This payment has timed out.',
      WEBHOOK_SIGNATURE_INVALID: 'The payment couldn’t be verified.',
      PAYMENT_GATEWAY_ERROR: 'The payment system is temporarily unavailable.',
      AUTH_PROVIDER_UNAVAILABLE: 'This sign-in option isn’t available. Please choose another.',
      LOGIN_STATE_INVALID: 'The sign-in timed out or was already used. Please start again.',
      IDENTITY_PROVIDER_ERROR: 'Couldn’t connect to LINE or Google. Please try again.',
      INVALID_CREDENTIALS: 'Wrong email or password',
      MFA_INVALID: 'The verification code is wrong or has expired.',
      MFA_REQUIRED: 'Verification with an authenticator app is required.',
      REFRESH_TOKEN_INVALID: 'Your session has expired. Please sign in again.',
      REFRESH_TOKEN_REUSED: 'You were signed out for your security. Please sign in again.',
      PASSWORD_CHANGE_REQUIRED: 'Please set a new password before continuing.',
      ACCOUNT_DISABLED: 'This account has been suspended. Please contact the administrator.',
      EMAIL_TAKEN: 'This email already has an account.',
      LAST_ADMIN: 'At least one active administrator is required.',
      CANNOT_MODIFY_SELF: 'You can’t do this to your own account.',
      PASSWORD_TOO_WEAK: 'The new password is too easy to guess.',
      LOGIN_PROVIDER_UNAVAILABLE: 'Viewer sign-in with LINE or Google is turned off.',
      COVER_FILE_INVALID: 'This photo can’t be the cover.',
    },
    details: {
      quotaExceeded: 'Not enough space: this file needs {requested} but only {available} is left.',
      fileTooLarge: 'The file is too large (maximum {max}).',
      unsupportedExtension: '.{extension} files aren’t supported.',
      folderNameTaken: 'A folder named “{name}” already exists here.',
      fileNameTaken: 'A file named “{name}” already exists here.',
      folderDepthExceeded: 'Folders can be nested at most {max, number} levels deep.',
      subscriptionNone: 'No plan yet.',
      subscriptionStatus: 'The plan is “{status}”.',
      shareRevoked: 'This link has expired. The photographer has turned it off.',
      shareExpired: 'This link has expired',
      shareUnavailable: 'This link has expired. Its photos are no longer available.',
      zipTooLarge:
        'One download can hold up to {maxFiles, number} photos and {maxBytes} in total (you selected {files, number} photos, {bytes}).',
      noFaceDetected: 'Photos with no face found: {count, number}',
      faceSearchNotFolder: 'Face search only works for links that share a whole folder.',
      faceSearchNotIndexed: 'Face search isn’t ready for the photos in this link yet.',
      checkoutPending: 'A payment is still pending (until {time}).',
      captchaRequired:
        'There have been too many searches from this network. Please confirm you are not a robot to continue.',
      captchaExpired: 'The check has expired. Please confirm again.',
      captchaInvalid: 'The check failed. Please try again.',
      rateLimitedWait:
        '{minutes, plural, one {Too many requests. Please wait # minute and try again.} other {Too many requests. Please wait # minutes and try again.}}',
    },
    hints: {
      heic: 'HEIC files aren’t supported yet. Please convert them to JPEG first.',
      raw: 'RAW files aren’t supported. Please export them as JPEG first.',
    },
    client: {
      network: 'No connection. Check your internet and try again.',
      contract: 'The server sent an unexpected answer. Please try again.',
      unknown: 'Something went wrong. Please try again.',
      emptyFile: 'This file is empty.',
      invalidRelativePath: 'A folder name in “{path}” isn’t valid.',
      uploadPlanMismatch: 'Upload settings changed. Please refresh and try again.',
      storageUpload: 'Couldn’t send the file to storage. Please try again.',
      zipFailed: 'Couldn’t prepare the zip file. Please try again.',
      zipExpired: 'The zip file has expired. Please download again.',
      zipTimeout: 'The zip file is taking too long. Please try again or select fewer photos.',
      saveFailed: 'Couldn’t save the photos. Please try again.',
      copyFailed: 'Couldn’t copy. Press and hold the link to copy it yourself.',
      consentVersionUnknown:
        'There is a new version of the consent text. Please refresh this page to read it before accepting.',
      captchaUnavailable:
        'The check is temporarily unavailable. Please wait a moment and try again.',
    },
  },
};
