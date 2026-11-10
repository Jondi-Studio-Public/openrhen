import AVFoundation
import SwiftUI
import UIKit

/// Camera view that reads one QR code and hands its text to `onCode` once. `onUnavailable` is called, with
/// words for the person, when the camera cannot be used (permission refused, no camera).
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onUnavailable: ((String) -> Void)?
    private let captureSession = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "org.openrhen.scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var delivered = false

    static let deniedMessage = "Camera access is off for OpenRhen. Turn it on in Settings > OpenRhen, or use the typed code instead."

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.configure() } else { self?.onUnavailable?(ScannerController.deniedMessage) }
                }
            }
        default:
            onUnavailable?(ScannerController.deniedMessage)
        }
    }

    private func configure() {
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              captureSession.canAddInput(input) else {
            onUnavailable?("This phone has no camera that can scan. Use the typed code instead.")
            return
        }
        captureSession.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else {
            onUnavailable?("The camera could not start. Use the typed code instead.")
            return
        }
        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
        sessionQueue.async { [captureSession] in captureSession.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [captureSession] in
            if captureSession.isRunning { captureSession.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !delivered, let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let text = code.stringValue else { return }
        delivered = true
        onCode?(text)
    }
}
