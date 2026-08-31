import SwiftUI
import WidgetKit

/// Entry point of the CueWidgets extension: the run Live Activity (spec
/// frame 4) and Halo's (E5 Island states + R6). Home Screen widgets can join
/// this bundle later.
@main
struct CueWidgetsBundle: WidgetBundle {
    var body: some Widget {
        CueRunLiveActivity()
        if #available(iOS 16.2, *) { HaloLiveActivity() }
    }
}
