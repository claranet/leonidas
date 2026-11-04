# -*- mode: ruby -*-
# vi: set ft=ruby :

VAGRANTFILE_API_VERSION = "2"

$routerStartup = <<SCRIPT
# Enable routing & connect to gateway
sysctl -w net.ipv4.ip_forward=1
#
# Enable traffic internet traffic
iptables -t nat -A POSTROUTING -j MASQUERADE
#
# Install node 26, redis and the snmp tools
apt-get update
apt-get install -y ca-certificates curl redis-server snmp
curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
apt-get install -y nodejs
systemctl enable --now redis-server
#
# Install dependencies and point Leonidas at the router's address
cd /vagrant && npm ci
echo '{ "proxy": { "address": "192.168.10.1" } }' > /vagrant/config/local.json
#
# ping the endpoints to activate the network
ping -c 1 192.168.10.2
ping -c 1 192.168.20.2
SCRIPT

$pollerStartup = <<SCRIPT
ip route replace default via 192.168.10.1
apt-get update
apt-get install -y snmp
SCRIPT

$serverStartup = <<SCRIPT
ip route replace default via 192.168.20.1
apt-get update
apt-get install -y snmpd
mv /etc/snmp/snmpd.conf /etc/snmp/snmpd.orig
grep -v agentaddress /etc/snmp/snmpd.orig > /etc/snmp/snmpd.conf
echo "agentaddress udp:161" >> /etc/snmp/snmpd.conf
echo "rocommunity public default" >> /etc/snmp/snmpd.conf
systemctl restart snmpd
SCRIPT

Vagrant.configure(VAGRANTFILE_API_VERSION) do |config|
  config.vm.box = "bento/ubuntu-24.04"

  config.vm.define "poller" do |poller|
    poller.vm.network "private_network", ip: "192.168.10.2"
    poller.vm.hostname = "poller"
    poller.vm.provision "shell", inline: $pollerStartup
  end

  config.vm.define "server" do |server|
    server.vm.network "private_network", ip: "192.168.20.2"
    server.vm.hostname = "server"
    server.vm.provision "shell", inline: $serverStartup
  end

  config.vm.define "router" do |router|
    router.vm.network "private_network", ip: "192.168.10.1"
    router.vm.network "private_network", ip: "192.168.20.1"
    router.vm.hostname = "router"
    router.vm.provision "shell", inline: $routerStartup
  end

end
