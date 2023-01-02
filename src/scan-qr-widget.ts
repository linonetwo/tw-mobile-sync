import type { Widget as IWidget, IChangedTiddlers } from 'tiddlywiki';
import jsQR from 'jsqr-es6';
import type { Point } from 'jsqr-es6/dist/locator';

const Widget = (require('$:/core/modules/widgets/widget.js') as { widget: typeof IWidget }).widget;

class ScanQRWidget extends Widget {
  // constructor(parseTreeNode: any, options: any) {
  //   super(parseTreeNode, options);
  // }

  refresh(_changedTiddlers: IChangedTiddlers) {
    return false;
  }

  /** id to prevent multiple loops */
  loopId = 0;

  /**
   * Lifecycle method: Render this widget into the DOM
   */
  render(parent: Node, _nextSibling: Node) {
    this.parentDomNode = parent;
    this.execute();

    const outputTiddlerTitle = this.getAttribute('outputTiddlerTitle');

    const containerElement = document.createElement('div');
    containerElement.innerHTML = `
    <div>
      <div id="scan-qr-widget-loadingMessage">🎥 Unable to access video stream (please make sure you have a webcam enabled)</div>
      <canvas id="scan-qr-widget-canvas" hidden></canvas>
      <div id="scan-qr-widget-output" hidden>
        <div id="scan-qr-widget-outputMessage">No QR code detected.</div>
        <div hidden><b>Data:</b> <span id="scan-qr-widget-outputData"></span></div>
      </div>
    </div>
    `;
    this.domNodes.push(containerElement);
    this.loopId += 1;
    const loopId = this.loopId;
    // wait till dom created
    requestAnimationFrame(() => void this.jsqr(loopId, containerElement, outputTiddlerTitle));
    parent.appendChild(containerElement);
  }

  async jsqr(loopId: number, containerElement: HTMLDivElement, outputTiddlerTitle?: string | undefined) {
    const video = document.createElement('video');
    const canvasElement = document.querySelector<HTMLCanvasElement>('#scan-qr-widget-canvas');
    if (canvasElement === null) {
      console.warn('ScanQRWidget: canvasElement is null');
      return;
    }
    const canvas = canvasElement.getContext('2d');
    const loadingMessage = document.querySelector<HTMLDivElement>('#scan-qr-widget-loadingMessage');
    const outputContainer = document.querySelector<HTMLDivElement>('#scan-qr-widget-output');
    const outputMessage = document.querySelector<HTMLDivElement>('#scan-qr-widget-outputMessage');
    const outputData = document.querySelector<HTMLSpanElement>('#scan-qr-widget-outputData');
    if (canvas === null || outputData === null) {
      console.warn('ScanQRWidget: canvas or outputData is null', { canvas, outputData });
      return;
    }

    // Use facingMode: environment to attemt to get the front camera on phones
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });

    function drawLine(begin: Point, end: Point, color: string | CanvasGradient | CanvasPattern) {
      if (canvas === null) {
        return;
      }
      canvas.beginPath();
      canvas.moveTo(begin.x, begin.y);
      canvas.lineTo(end.x, end.y);
      canvas.lineWidth = 4;
      canvas.strokeStyle = color;
      canvas.stroke();
    }

    let lastResult: string | undefined;

    const tick = () => {
      if (
        loadingMessage === null ||
        canvasElement === null ||
        outputContainer === null ||
        canvas === null ||
        outputMessage === null ||
        outputData === null ||
        outputData.parentElement === null
      ) {
        console.warn(
          'ScanQRWidget: !loadingMessage || !canvasElement || !outputContainer || !canvas || !outputMessage || !outputData || !outputData.parentElement, it is null',
          {
            loadingMessage,
            canvasElement,
            outputContainer,
            canvas,
            outputMessage,
            outputData,
            'outputData.parentElement': outputData?.parentElement,
          },
        );

        return;
      }
      loadingMessage.textContent = '⌛ Loading video...';
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        loadingMessage.hidden = true;
        canvasElement.hidden = false;
        outputContainer.hidden = false;

        canvasElement.height = video.videoHeight;
        canvasElement.width = video.videoWidth;
        canvas.drawImage(video, 0, 0, canvasElement.width, canvasElement.height);
        const imageData = canvas.getImageData(0, 0, canvasElement.width, canvasElement.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });
        outputMessage.hidden = true;
        outputData.parentElement.hidden = false;
        let result;
        if (code === null) {
          result = 'No code detected';
        } else {
          drawLine(code.location.topLeftCorner, code.location.topRightCorner, '#FF3B58');
          drawLine(code.location.topRightCorner, code.location.bottomRightCorner, '#FF3B58');
          drawLine(code.location.bottomRightCorner, code.location.bottomLeftCorner, '#FF3B58');
          drawLine(code.location.bottomLeftCorner, code.location.topLeftCorner, '#FF3B58');
          result = code.data;
        }

        if (result !== lastResult) {
          outputData.textContent = outputData.textContent ?? '';
          outputData.textContent += `${result}\n`;
          lastResult = result;
          // fast check of ip address
          // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
          if (outputTiddlerTitle && result.includes(':')) {
            const textFieldTiddler = $tw.wiki.getTiddler(outputTiddlerTitle);
            const newServerInfoTiddler = {
              title: outputTiddlerTitle,
              text: result,
              ...textFieldTiddler?.fields,
            };
            $tw.wiki.addTiddler(newServerInfoTiddler);
          }
        }
      }
      // if new loop happened, this.loopId will > loopId, stop current loop
      if (this.loopId === loopId && containerElement.offsetParent !== null) {
        requestAnimationFrame(tick);
      } else {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
      }
    };
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // required to tell iOS safari we don't want fullscreen
    await video.play();
    requestAnimationFrame(tick);
  }
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
exports.widget = ScanQRWidget;
exports.ScanQRWidget = ScanQRWidget;
