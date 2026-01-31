import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../../core/app_state.dart';

class GoogleContactsImportScreen extends StatelessWidget {
  final AppState appState;
  const GoogleContactsImportScreen({super.key, required this.appState});

  bool get _supported =>
      kIsWeb ||
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Import from Google')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: _supported
            ? const Text(
                'Google import route is live.\n\n'
                'Next step is OAuth + contacts fetch, but the navigation + screen surface is stable.',
              )
            : const Text(
                'Google sign-in / OAuth isn’t supported on Windows desktop in this build.\n'
                'Use Android/iOS/Web for OAuth flows.',
              ),
      ),
    );
  }
}
