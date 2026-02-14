import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';

class ManualAddContactScreen extends StatefulWidget {
  final AppState appState;
  const ManualAddContactScreen({super.key, required this.appState});

  @override
  State<ManualAddContactScreen> createState() => _ManualAddContactScreenState();
}

class _ManualAddContactScreenState extends State<ManualAddContactScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();

  bool busy = false;
  String? status;

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => status = null);

    if (!_formKey.currentState!.validate()) return;

    setState(() => busy = true);

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final svc = ContactImportService(api, widget.appState);


      final c = Contact(
        id: 'manual_${DateTime.now().millisecondsSinceEpoch}',
        name: _nameCtrl.text.trim(),
        phone: _phoneCtrl.text.trim().isEmpty ? null : _phoneCtrl.text.trim(),
        email: _emailCtrl.text.trim().isEmpty ? null : _emailCtrl.text.trim(),
      );

      final resp = await svc.importContacts(method: 'manual', contacts: [c]);

      setState(() => status = 'Added ✅ (added: ${resp['added'] ?? 1})');
    } catch (e) {
      setState(() => status = 'Error: $e');
    } finally {
      setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Contact')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Name'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Name required' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phoneCtrl,
                decoration: const InputDecoration(labelText: 'Phone (optional)'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _emailCtrl,
                decoration: const InputDecoration(labelText: 'Email (optional)'),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: busy ? null : _save,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(busy ? 'Saving…' : 'Save Contact'),
                  ),
                ),
              ),
              if (status != null) ...[
                const SizedBox(height: 12),
                Text(status!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
