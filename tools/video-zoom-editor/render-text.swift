import AppKit
import Foundation

struct TextRenderConfig: Decodable {
    let outputPath: String
    let text: String
    let fontSize: Double
    let maxWidth: Double
}

enum RenderError: Error, CustomStringConvertible {
    case missingConfigPath
    case invalidImage
    case writeFailed

    var description: String {
        switch self {
        case .missingConfigPath:
            return "Missing JSON config path."
        case .invalidImage:
            return "Could not create PNG image."
        case .writeFailed:
            return "Could not write PNG image."
        }
    }
}

func loadConfig() throws -> TextRenderConfig {
    guard CommandLine.arguments.count >= 2 else {
        throw RenderError.missingConfigPath
    }

    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(TextRenderConfig.self, from: data)
}

func renderText(_ config: TextRenderConfig) throws {
    let paddingX = CGFloat(max(16, config.fontSize * 0.48))
    let paddingY = CGFloat(max(10, config.fontSize * 0.32))
    let fontSize = CGFloat(min(max(config.fontSize, 12), 120))
    let maxWidth = CGFloat(min(max(config.maxWidth, 120), 1800))
    let text = config.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? " "
        : config.text

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping

    let font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white,
        .paragraphStyle: paragraph,
    ]

    let attributedText = NSAttributedString(string: text, attributes: attributes)
    let textRect = attributedText.boundingRect(
        with: NSSize(width: maxWidth, height: 4000),
        options: [.usesLineFragmentOrigin, .usesFontLeading]
    )

    let imageWidth = ceil(textRect.width + paddingX * 2)
    let imageHeight = ceil(textRect.height + paddingY * 2)
    let imageSize = NSSize(width: max(1, imageWidth), height: max(1, imageHeight))

    let image = NSImage(size: imageSize)
    image.lockFocus()

    NSColor.clear.setFill()
    NSRect(origin: .zero, size: imageSize).fill()

    let backgroundPath = NSBezierPath(
        roundedRect: NSRect(origin: .zero, size: imageSize),
        xRadius: min(18, imageSize.height / 3),
        yRadius: min(18, imageSize.height / 3)
    )
    NSColor(calibratedWhite: 0.06, alpha: 0.78).setFill()
    backgroundPath.fill()

    let textDrawRect = NSRect(
        x: paddingX,
        y: paddingY,
        width: imageSize.width - paddingX * 2,
        height: imageSize.height - paddingY * 2
    )
    attributedText.draw(with: textDrawRect, options: [.usesLineFragmentOrigin, .usesFontLeading])

    image.unlockFocus()

    guard
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:])
    else {
        throw RenderError.invalidImage
    }

    let outputURL = URL(fileURLWithPath: config.outputPath)
    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )

    guard FileManager.default.createFile(atPath: outputURL.path, contents: png) else {
        throw RenderError.writeFailed
    }
}

do {
    try renderText(loadConfig())
} catch {
    fputs("render-text error: \(error)\n", stderr)
    exit(1)
}
