
# Shaka Player with Chapters and Thumbnails

This project is a modified version of [Shaka Player](https://github.com/google/shaka-player), an open-source media player library developed by Google.

## Features
- **Chapters Support**: This version includes added functionality to handle video chapters using VTT files.
- **Thumbnail Preview Support**: Added support for thumbnail previews based on VTT files.

## Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/Monem-Benjeddou/Shaka-Player-Extended.git
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Compile the project:
   ```bash
   npm run prepublishOnly
   ```
4. Required Files After Compilation
Ensure the following files exist after compilation to enable proper functionality:

    ```html
    <link rel="stylesheet" href="~/js/dist/controls.css"  />
    <script src="~/js/dist/shaka-player.compiled.js"></script>
    
    <!-- Shaka Player UI -->
    <script src="~/js/dist/shaka-player.ui.js"></script>
    ```
These files should be included in your final output after compiling to ensure Shaka Player functions properly with both chapters and thumbnail previews.
## Usage
Integrate this library as you would with the original Shaka Player. See [documentation](https://shaka-player-demo.appspot.com/docs/api/tutorial-welcome.html) for guidance.

### Adding Chapters
To add chapters:
1. Create a `.vtt` file containing chapter information. Example format:
   ```vtt
   WEBVTT

   00:00:00.000 --> 00:01:00.000
   Introduction

   00:01:00.000 --> 00:02:00.000
   Chapter 1

   00:02:00.000 --> 00:03:00.000
   Chapter 2
   ```
2. Load the `.vtt` file into the player using the custom API provided.
   Example code for loading chapters:

   ```javascript
    // Initialize Shaka Player
    var player = new shaka.Player(videoElement);
    
    // Load video
    player.load('path/to/your/video.mp4').then(function() {
    // Load the chapters from the VTT file
    player.addChapters('path/to/your/chapters.vtt',"en");
    }).catch(function(error) {
    console.error('Error loading the video or chapters:', error);
    const ui = new shaka.ui.Overlay(player, videoContainer, videoElement);
    });
   ```


### Adding Thumbnails
To add thumbnail previews:
1. Create a `.vtt` file containing thumbnail information. Example format:
   ```vtt
   WEBVTT

   00:00:00.000 --> 00:00:05.000
   /path-to-thumbnails/thumbnail1.jpg

   00:00:05.000 --> 00:00:10.000
   /path-to-thumbnails/thumbnail2.jpg

   00:00:10.000 --> 00:00:15.000
   /path-to-thumbnails/thumbnail3.jpg
   ```
2. Place the thumbnails in the specified path (relative or absolute).
3. Load the `.vtt` file into the player for thumbnail previews using the custom API. Example:
   ```javascript
   player.addThumbnails('path/to/your/thumbnail.vtt',"en");
   ```

## License
This project is licensed under the [Apache License 2.0](LICENSE). It includes significant contributions from [Shaka Player](https://github.com/google/shaka-player).

## Acknowledgments
Special thanks to the original Shaka Player team for building an excellent foundation for media playback.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any bugs or new features.

## Disclaimer
This is not an official release of Shaka Player and is maintained independently. It is provided as-is without warranties.
