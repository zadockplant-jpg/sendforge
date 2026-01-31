import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../../core/app_state.dart';

class DeviceContactsImportScreen extends StatelessWidget {
  final AppState appState;
  const DeviceContactsImportScreen({super.key, required this.appState});

  bool get _supportedMobile =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import from Device')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: _supportedMobile
            ? const Text(
                'Device import is ready to wire (permissions + picker). '
                'This screen is the stable route target.',
              )
            : const Text(
                'Device contacts import is not supported on Windows. '
                'Run this on Android/iOS when we add permissions + picker.',
              ),
      ),
    );
  }
}
