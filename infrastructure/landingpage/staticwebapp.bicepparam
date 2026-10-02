using 'staticwebapp.bicep'

// Public, non-secret defaults for the project landing page. Subscription and
// resource group are passed on the command line, not stored here.
param name = 'magic-stick-landingpage'
param location = 'westeurope'
param skuName = 'Standard'
