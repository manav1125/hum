import SwiftUI
import WidgetKit

/// Entry point of the CueWidgets extension. Today it ships only the run
/// Live Activity (Dynamic Island + Lock Screen, spec frame 4); Home Screen
/// widgets can join this bundle later.
@main
struct CueWidgetsBundle: WidgetBundle {
    var body: some Widget {
        CueRunLiveActivity()
    }
}
