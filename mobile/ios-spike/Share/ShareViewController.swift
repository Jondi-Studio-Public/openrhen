import UIKit

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let text = UITextView(frame: view.bounds.insetBy(dx: 12, dy: 60))
        text.isEditable = false
        text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        text.text = Probe.run(write: true).joined(separator: "\n")
        view.addSubview(text)
        let done = UIButton(type: .system, primaryAction: UIAction(title: "Done") { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        done.frame = CGRect(x: 12, y: 16, width: 80, height: 36)
        view.addSubview(done)
    }
}
